import type { BetType, BetStatus, SportType } from './domain'

export interface ApiSuccess<T = void> {
  data: T
  message?: string
}

export interface ApiError {
  error: string
  code: string
  details?: Record<string, string[]>
}

export type ApiResponse<T = void> = ApiSuccess<T> | ApiError

export interface PaginationMeta {
  page: number
  pageSize: number
  total: number
  totalPages: number
  hasNextPage: boolean
  hasPreviousPage: boolean
}

export interface PaginatedResponse<T> {
  data: T[]
  pagination: PaginationMeta
}

/** Filtros para la lista de BetRecords (reemplaza ArbitrageFilters de Phase 1) */
export interface BetRecordFilters {
  type?: BetType[]
  status?: BetStatus[]
  sport?: SportType[]
  bookmakerId?: string[]
  dateFrom?: string
  dateTo?: string
  minProfit?: number
  maxProfit?: number
  search?: string
  page?: number
  pageSize?: number
  sortBy?: 'datePlaced' | 'dateSettled' | 'totalStake' | 'grossProfit' | 'roi'
  sortOrder?: 'asc' | 'desc'
}

export interface AnalyticsPeriodParams {
  from: string
  to: string
  groupBy?: 'day' | 'week' | 'month'
}

export interface ActionResult<T = void> {
  success: boolean
  data?: T
  error?: string
  code?: string
  fieldErrors?: Record<string, string[]>
}
