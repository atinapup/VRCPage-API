/** The process is up and answering. */
export class Liveness {
  status!: 'ok';
}

/** The API can serve traffic: the database answers and partitions exist a week ahead. */
export class Readiness {
  status!: 'ok';
  /** development or production. */
  environment!: string;
}
