import { type CanActivate, type ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { PagesService } from '../pages/pages.service.js';

/**
 * Admins only, after SessionGuard. Anyone else gets the same 404 as a route
 * that doesn't exist, so the admin area can't be found by probing for it.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly pages: PagesService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const viewer = context.switchToHttp().getRequest<Request>().viewer;
    if (!viewer || !(await this.pages.isAdmin(viewer.accountId))) throw new NotFoundException();
    return true;
  }
}
