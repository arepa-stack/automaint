import { sql } from 'drizzle-orm'

// ponytail: haversine en SQL sobre columnas lat/lng; migrar a PostGIS si el volumen lo pide
export const distanceKm = (lat: number, lng: number) => sql<number>`(
  6371 * acos(
    least(1.0,
      cos(radians(${lat})) * cos(radians(partners.lat)) *
      cos(radians(partners.lng) - radians(${lng})) +
      sin(radians(${lat})) * sin(radians(partners.lat))
    )
  )
)`
