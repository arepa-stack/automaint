export class ApiError extends Error {
  constructor(public statusCode: number, message: string, public code?: string) {
    super(message)
  }
}

export const notFound = (what = 'Recurso') => new ApiError(404, `${what} no encontrado`)
export const forbidden = (msg = 'No autorizado para esta acción') => new ApiError(403, msg)
export const badRequest = (msg: string, code?: string) => new ApiError(400, msg, code)
export const unauthorized = (msg = 'No autenticado') => new ApiError(401, msg)
export const tooManyRequests = (msg: string) => new ApiError(429, msg, 'RATE_LIMIT')
