import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { localPath, text } from '../common/input.js';
import { requestContext } from '../common/request-context.js';
import {
  EmailChangeConfirmRequest,
  EmailChangeRequest,
  EmailChangeStarted,
  PendingSignIn,
  ProviderRedirect,
  Providers,
  ResendSignInCodeRequest,
  SessionInfo,
  SignInCodeRequest,
  SignInMethods,
  SignInRequest,
  SocialLinkRequest,
  SocialSignInRequest,
} from './auth.dto.js';
import { AuthService, type CookieHeaders, SOCIAL_PROVIDERS, type SocialProvider, type Viewer } from './auth.service.js';
import { CurrentViewer, SessionGuard } from './session.guard.js';

/** Hands Better Auth's cookies to the website, which sets them on its own origin. */
function passCookies(response: Response, headers: CookieHeaders): void {
  const cookies = headers?.getSetCookie() ?? [];
  if (cookies.length > 0) response.append('Set-Cookie', cookies);
}

function provider(value: string): SocialProvider {
  if (!(SOCIAL_PROVIDERS as readonly string[]).includes(value)) throw new NotFoundException(`There is no sign-in provider called ${value}.`);
  return value as SocialProvider;
}

const PROVIDER_PARAM = { name: 'provider', enum: SOCIAL_PROVIDERS } as const;

/**
 * Sign-in, for the website's server. The session lives in a cookie on the
 * website's origin: the website forwards it here with every call, and passes
 * on any Set-Cookie these answers carry.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Which sign-in providers this server offers. */
  @Get('providers')
  providers(): Providers {
    return this.auth.providers();
  }

  /**
   * Send a sign-in code, once the Turnstile token passes. Same answer whether or not the address has an account.
   * Within the resend cooldown nothing is sent, and the answer says so (sent: false).
   */
  @Post('sign-in-code')
  @HttpCode(200)
  requestSignInCode(@Req() request: Request, @Body() body: SignInCodeRequest): Promise<PendingSignIn> {
    return this.auth.requestSignInCode(requestContext(request), text(body, 'email', 320), text(body, 'botCheckToken', 2048));
  }

  /** Send another code to the address a pending token names. */
  @Post('sign-in-code/resend')
  @HttpCode(200)
  resendSignInCode(@Req() request: Request, @Body() body: ResendSignInCodeRequest): Promise<PendingSignIn> {
    return this.auth.resendSignInCode(requestContext(request), text(body, 'pendingToken', 400));
  }

  /** Sign in with a code; sets the session cookie. A first sign-in creates the account. */
  @Post('sign-in')
  @HttpCode(204)
  async signIn(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: SignInRequest): Promise<void> {
    passCookies(response, await this.auth.verifySignInCode(requestContext(request), text(body, 'email', 320), text(body, 'code', 32)));
  }

  /** Start signing in with Discord or GitHub: the address to send the browser to. */
  @Post('social/:provider/sign-in')
  @HttpCode(200)
  @ApiParam(PROVIDER_PARAM)
  async socialSignIn(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('provider') name: string,
    @Body() body: SocialSignInRequest,
  ): Promise<ProviderRedirect> {
    const { url, headers } = await this.auth.startSocial(
      requestContext(request),
      provider(name),
      'sign-in',
      localPath(body, 'callbackURL'),
      localPath(body, 'errorCallbackURL'),
    );
    passCookies(response, headers);
    return { url };
  }

  /** Start connecting Discord or GitHub to the signed-in account. */
  @Post('social/:provider/link')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiParam(PROVIDER_PARAM)
  async socialLink(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('provider') name: string,
    @Body() body: SocialLinkRequest,
  ): Promise<ProviderRedirect> {
    const back = localPath(body, 'callbackURL');
    const { url, headers } = await this.auth.startSocial(requestContext(request), provider(name), 'link', back, back);
    passCookies(response, headers);
    return { url };
  }

  /** Disconnect Discord or GitHub. Needs a recent sign-in. */
  @Delete('social/:provider')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  @ApiParam(PROVIDER_PARAM)
  async socialUnlink(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('provider') name: string): Promise<void> {
    await this.auth.unlinkSocial(requestContext(request), viewer, provider(name));
  }

  /** The signed-in account; 401 when there is none. */
  @Get('session')
  @UseGuards(SessionGuard)
  session(@CurrentViewer() viewer: Viewer): SessionInfo {
    return { accountId: viewer.accountId, email: viewer.email };
  }

  /** Sign out; clears the session cookie. */
  @Post('sign-out')
  @HttpCode(204)
  async signOut(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    const context = requestContext(request);
    passCookies(response, await this.auth.signOut(context, await this.auth.viewer(context)));
  }

  /** Discord and GitHub: offered here, and attached to the signed-in account. */
  @Get('sign-in-methods')
  @UseGuards(SessionGuard)
  signInMethods(@Req() request: Request): Promise<SignInMethods> {
    return this.auth.signInMethods(requestContext(request));
  }

  /** Send a code to a new address. Needs a recent sign-in. */
  @Post('email-change')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async requestEmailChange(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Body() body: EmailChangeRequest): Promise<EmailChangeStarted> {
    const resendIn = await this.auth.requestEmailChange(requestContext(request), viewer, text(body, 'newEmail', 320));
    return { resendIn };
  }

  /** Switch to the new address with the code sent to it. */
  @Post('email-change/confirm')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async confirmEmailChange(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Body() body: EmailChangeConfirmRequest): Promise<void> {
    await this.auth.confirmEmailChange(requestContext(request), viewer, text(body, 'newEmail', 320), text(body, 'code', 32));
  }

  /** Delete the signed-in account and everything it owns. Needs a recent sign-in; clears the session cookie. */
  @Delete('account')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async deleteAccount(@Req() request: Request, @Res({ passthrough: true }) response: Response, @CurrentViewer() viewer: Viewer): Promise<void> {
    passCookies(response, await this.auth.deleteAccount(requestContext(request), viewer));
  }
}
