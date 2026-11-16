// Small Response helpers shared by the Workers.

export const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit): Response => Response.json(body, { status, headers });

export const errorResponse = (status: number, error: string, message?: string): Response => jsonResponse(message ? { error, message } : { error }, status);
