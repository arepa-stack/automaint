import { createClient } from '@supabase/supabase-js'
import { config } from '../config'
import { badRequest } from './errors'

export type Bucket = 'vehicle-photos' | 'receipts' | 'listings' | 'partner-docs'

const MAX_FILE_BYTES = 10 * 1024 * 1024
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

const supabase = config.storageDriver === 'supabase'
  ? createClient(config.supabaseUrl!, config.supabaseServiceRoleKey!)
  : null

/** Guarda un archivo y devuelve su path interno (`bucket/nombre`). */
export async function saveFile(bucket: Bucket, file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) throw badRequest('Archivo supera 10MB')
  if (!ALLOWED_TYPES.includes(file.type)) throw badRequest(`Tipo de archivo no permitido: ${file.type}`)

  const ext = file.name.split('.').pop() ?? 'bin'
  const name = `${crypto.randomUUID()}.${ext}`

  if (supabase) {
    const { error } = await supabase.storage.from(bucket).upload(name, file, { contentType: file.type })
    if (error) throw new Error(`Supabase Storage: ${error.message}`)
  } else {
    await Bun.write(`${config.uploadDir}/${bucket}/${name}`, file)
  }
  return `${bucket}/${name}`
}

/** Convierte un path interno en URL descargable por el cliente. */
export function fileUrl(path: string | null): string | null {
  if (!path) return null
  if (supabase) {
    const [bucket, ...rest] = path.split('/')
    return supabase.storage.from(bucket!).getPublicUrl(rest.join('/')).data.publicUrl
  }
  return `${config.appBaseUrl}/files/${path}`
}
