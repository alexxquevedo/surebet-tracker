import { z } from 'zod'

// ════════════════════════════════════════
// SCHEMAS ZOD
// ════════════════════════════════════════

export const createBetLegSchema = z.object({
  bookmakerId: z.string().min(1, 'Selecciona una casa de apuestas'),
  selection: z.string().min(1, 'Introduce la selección').max(200),
  odds: z
    .number({ invalid_type_error: 'Las cuotas deben ser un número' })
    .gt(1, 'Las cuotas deben ser mayores que 1'),
  stake: z
    .number({ invalid_type_error: 'El stake debe ser un número' })
    .positive('El stake debe ser positivo'),
})

export const createArbitrageSchema = z.object({
  sport: z.enum([
    'FOOTBALL','TENNIS','BASKETBALL','BASEBALL','HOCKEY',
    'CRICKET','RUGBY','GOLF','MMA','BOXING',
    'CYCLING','MOTORSPORT','ESPORTS','OTHER',
  ]),
  competition: z.string().max(200).optional(),
  eventName: z.string().min(2, 'El nombre del evento es demasiado corto').max(300),
  eventDate: z.date({ required_error: 'Selecciona la fecha del evento' }),
  title: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
  legs: z
    .array(createBetLegSchema)
    .min(2, 'Un arbitraje necesita al menos 2 piernas')
    .max(5, 'Máximo 5 piernas por arbitraje'),
  tagIds: z.array(z.string()).optional(),
})

export const settleArbitrageSchema = z.object({
  winningLegId: z.string().min(1, 'Selecciona la pierna ganadora'),
  settledAt: z.date().optional(),
  notes: z.string().max(500).optional(),
})

export const voidArbitrageSchema = z.object({
  notes: z.string().max(500).optional(),
})

export const createBookmakerSchema = z.object({
  name: z.string().min(2, 'Nombre demasiado corto').max(100),
  country: z.string().max(100).optional(),
  currency: z.string().length(3, 'Código de moneda inválido').default('EUR'),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Color hex inválido')
    .optional(),
  websiteUrl: z.string().url('URL inválida').optional().or(z.literal('')),
  notes: z.string().max(500).optional(),
  initialBalance: z
    .number({ required_error: 'El saldo inicial es obligatorio' })
    .min(0, 'El saldo inicial no puede ser negativo'),
})

export const updateBookmakerSchema = createBookmakerSchema.partial().omit({ initialBalance: true })

export const bookmakerTransactionSchema = z.object({
  type: z.enum(['DEPOSIT', 'WITHDRAWAL', 'BONUS', 'MANUAL_ADJUSTMENT']),
  amount: z.number().positive('El importe debe ser positivo'),
  notes: z.string().max(500).optional(),
})

export const updateUserSettingsSchema = z.object({
  timezone: z.string().optional(),
  primaryCurrency: z.string().length(3).optional(),
  defaultStake: z.number().positive().optional().nullable(),
  roundStakesTo: z.number().int().min(1).max(100).optional(),
  emailOnSettle: z.boolean().optional(),
  emailOnRoiTarget: z.boolean().optional(),
  roiTargetPercent: z.number().min(0).max(1000).optional().nullable(),
  defaultChartPeriod: z.enum(['7d', '30d', '90d', 'ytd', 'all']).optional(),
  compactMode: z.boolean().optional(),
})

export const registerSchema = z
  .object({
    name: z.string().min(2, 'El nombre es demasiado corto').max(100),
    email: z.string().email('Email inválido'),
    password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Las contraseñas no coinciden',
    path: ['confirmPassword'],
  })

export const loginSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(1, 'La contraseña es obligatoria'),
})

// ════════════════════════════════════════
// TIPOS INFERIDOS
// ════════════════════════════════════════

export type CreateArbitrageFormData = z.infer<typeof createArbitrageSchema>
export type CreateBetLegFormData = z.infer<typeof createBetLegSchema>
export type SettleArbitrageFormData = z.infer<typeof settleArbitrageSchema>
export type VoidArbitrageFormData = z.infer<typeof voidArbitrageSchema>
export type CreateBookmakerFormData = z.infer<typeof createBookmakerSchema>
export type UpdateBookmakerFormData = z.infer<typeof updateBookmakerSchema>
export type BookmakerTransactionFormData = z.infer<typeof bookmakerTransactionSchema>
export type UpdateUserSettingsFormData = z.infer<typeof updateUserSettingsSchema>
export type RegisterFormData = z.infer<typeof registerSchema>
export type LoginFormData = z.infer<typeof loginSchema>
