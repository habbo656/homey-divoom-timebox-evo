// Errors the `ConnectionManager` rejects its promises with.

/** `send`/`request` was called while there is no live link. */
export class NotConnectedError extends Error {
  constructor(message = 'not connected') {
    super(message);
    this.name = 'NotConnectedError';
  }
}

/** No matching reply arrived within the request timeout. */
export class RequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestTimeoutError';
  }
}

/** The link went away (or the manager was stopped) while the call was pending. */
export class LinkLostError extends Error {
  constructor(message = 'link lost') {
    super(message);
    this.name = 'LinkLostError';
  }
}
