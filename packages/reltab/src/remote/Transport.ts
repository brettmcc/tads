/**
 * Generic interface for simple, reliable remote function and method
 * invocation.
 *
 * Requests and responses are structured-cloneable plain values (objects,
 * arrays, numbers, strings, booleans, null, bigint, Date, typed arrays).
 * The Electron transport passes them across IPC via structured clone with
 * no JSON encoding; class instances (Schema, TableRep) are converted to
 * plain JSON forms at the reltab remoting layer before they reach the
 * transport.
 */

export interface TransportClient {
  invoke(functionName: string, req: any): Promise<any>;
}

export type RequestHandler = (req: any) => Promise<any>;

export interface TransportServer {
  registerInvokeHandler(functionName: string, handler: RequestHandler): void;
}
