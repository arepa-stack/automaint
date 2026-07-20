import { config } from '../config'

// Autocontenido (sin imports de Elysia/Drizzle) para poder portarlo a otro proyecto sin refactor.
export type DiagnosisResult = {
  offtopic: boolean // true si el texto no describe un problema del vehículo (gym, belleza, etc.)
  summary: string
  causes: { title: string; detail: string; likelihood: 'alta' | 'media' | 'baja' }[]
  checks: string[]
  severity: 'baja' | 'media' | 'alta'
  recommendation: string
}

const MOCK: DiagnosisResult = {
  offtopic: false,
  summary: 'Diagnóstico no disponible (falta GEMINI_API_KEY).',
  causes: [],
  checks: [],
  severity: 'media',
  recommendation: 'Configura GEMINI_API_KEY para diagnóstico real.',
}

export async function diagnose(
  make: string, model: string, year: number, symptom: string, context = '',
): Promise<{ result: DiagnosisResult; source: 'llm' | 'mock' }> {
  if (!config.geminiApiKey) {
    console.log(`[llm] (mock) ${make} ${model} ${year} — ${symptom}`)
    return { result: MOCK, source: 'mock' }
  }

  const prompt = `Eres mecánico automotriz experto. SOLO diagnosticas problemas de vehículos. ` +
    `Vehículo: ${make} ${model} ${year}.` +
    (context ? ` Historial del vehículo:\n${context}\n` : ' ') +
    `Texto del usuario: "${symptom}". ` +
    `Ten en cuenta el historial: no repitas lo que ya se reparó, y si un síntoma reincide tras una ` +
    `reparación previa, apunta a la siguiente causa probable. ` +
    `Si el texto NO describe un problema/síntoma del vehículo (ej. pide rutina de gym, ` +
    `consejo de belleza, o cualquier tema ajeno a mecánica), responde JSON con offtopic:true ` +
    `y el resto vacío. Si SÍ es un problema del vehículo, diagnostícalo en español con offtopic:false. ` +
    `Responde SOLO JSON: {offtopic:boolean, summary, causes:[{title,detail,likelihood:"alta|media|baja"}], checks:[string], severity:"baja|media|alta", recommendation}.`

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    }),
  })
  if (!res.ok) {
    console.error(`[llm] Gemini ${res.status}: ${await res.text()}`)
    return { result: MOCK, source: 'mock' }
  }
  const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
  const result = JSON.parse(text) as DiagnosisResult
  return { result, source: 'llm' }
}

// ── Evaluación de anuncio para compradores ──────────────────────────────────

export type ListingEvaluation = {
  offtopic: boolean
  verdict: 'recomendable' | 'con_reservas' | 'no_recomendable' | 'sin_datos'
  summary: string
  pros: string[]
  cons: string[]
  questionsToAsk: string[] // qué preguntarle al vendedor
}

const MOCK_EVAL: ListingEvaluation = {
  offtopic: false,
  verdict: 'sin_datos',
  summary: 'Evaluación no disponible (falta GEMINI_API_KEY).',
  pros: [],
  cons: [],
  questionsToAsk: [],
}

export async function evaluateListing(
  context: string, question: string,
): Promise<{ result: ListingEvaluation; source: 'llm' | 'mock' }> {
  if (!config.geminiApiKey) {
    console.log(`[llm] (mock eval) ${question}`)
    return { result: MOCK_EVAL, source: 'mock' }
  }

  const prompt = `Eres asesor experto en compra de autos usados. Evalúa objetivamente si conviene comprar ` +
    `este vehículo basándote ÚNICAMENTE en el historial verificado provisto. NO inventes fallas ni ` +
    `problemas mecánicos que no estén en los datos. Un mantenimiento documentado es positivo; la ausencia ` +
    `de registros es motivo de cautela, no de rechazo automático. Si no hay historial verificado, verdict "sin_datos".\n` +
    `Datos del anuncio e historial:\n${context}\n` +
    `Pregunta del comprador: "${question}". ` +
    `Si la pregunta no trata sobre evaluar/comprar este carro (ej. otro tema), responde offtopic:true y el resto vacío. ` +
    `Responde SOLO JSON: {offtopic:boolean, verdict:"recomendable|con_reservas|no_recomendable|sin_datos", summary, pros:[string], cons:[string], questionsToAsk:[string]}.`

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    }),
  })
  if (!res.ok) {
    console.error(`[llm] Gemini eval ${res.status}: ${await res.text()}`)
    return { result: MOCK_EVAL, source: 'mock' }
  }
  const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
  const result = JSON.parse(text) as ListingEvaluation
  return { result, source: 'llm' }
}

// ponytail: caché exact-match sobre texto normalizado. Frases distintas del mismo
// problema no comparten caché. Upgrade si el hit-rate es bajo: embeddings + pgvector.
export function normalizeSymptom(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}
