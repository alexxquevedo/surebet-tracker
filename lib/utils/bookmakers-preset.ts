/**
 * lib/utils/bookmakers-preset.ts
 *
 * Lista de casas de apuestas predefinidas para la incorporación rápida.
 * Los colores representan la identidad de marca de cada operador.
 */

export interface BookmakerPreset {
  name:       string
  color:      string
  currency:   string
  country:    string
  websiteUrl: string
}

export const BOOKMAKER_PRESETS: BookmakerPreset[] = [
  { name: 'Bet365',       color: '#00A651', currency: 'EUR', country: 'GB', websiteUrl: 'https://www.bet365.es' },
  { name: 'Winamax',      color: '#E40027', currency: 'EUR', country: 'FR', websiteUrl: 'https://www.winamax.es' },
  { name: 'PokerStars',   color: '#C8A951', currency: 'EUR', country: 'ES', websiteUrl: 'https://www.pokerstars.es' },
  { name: 'Bwin',         color: '#333333', currency: 'EUR', country: 'ES', websiteUrl: 'https://sports.bwin.es' },
  { name: 'Betfair',      color: '#FFB81C', currency: 'EUR', country: 'GB', websiteUrl: 'https://www.betfair.es' },
  { name: 'Betsson',      color: '#E5001A', currency: 'EUR', country: 'MT', websiteUrl: 'https://www.betsson.es' },
  { name: 'LeoVegas',     color: '#F7A600', currency: 'EUR', country: 'SE', websiteUrl: 'https://www.leovegas.es' },
  { name: 'Marathonbet',  color: '#002060', currency: 'EUR', country: 'CY', websiteUrl: 'https://www.marathonbet.es' },
  { name: 'William Hill', color: '#007AC1', currency: 'EUR', country: 'GB', websiteUrl: 'https://www.williamhill.es' },
  { name: '888sport',     color: '#F27421', currency: 'EUR', country: 'GI', websiteUrl: 'https://www.888sport.es' },
  { name: 'Codere',       color: '#E2001A', currency: 'EUR', country: 'ES', websiteUrl: 'https://www.codere.es'  },
  { name: 'Sportium',     color: '#0066CC', currency: 'EUR', country: 'ES', websiteUrl: 'https://www.sportium.es' },
  { name: 'Retabet',      color: '#E41113', currency: 'EUR', country: 'ES', websiteUrl: 'https://www.retabet.es' },
]
