import { PrismaClient } from '@prisma/client'
import { createHash } from 'crypto'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

// Demo API key — usar en: Authorization: Bearer <DEMO_API_KEY>
const DEMO_API_KEY = 'sbtp_demo1234_DEMO_FIXED_KEY_FOR_TESTING_ONLY'

// IDs fijos para seed idempotente (upsert safe)
const ID = {
  user:     'usr_demo',
  bet365:   'bm_bet365',
  winamax:  'bm_winamax',
  betfair:  'bm_betfair',
  pinnacle: 'bm_pinnacle',
  arb1:     'br_arb1',
  arb1L1:   'bl_arb1_l1',  // Bet365 leg — PLACED
  arb1L2:   'bl_arb1_l2',  // Winamax leg — PLACED
  arb2:     'br_arb2',
  arb2L1:   'bl_arb2_l1',  // Bet365 leg — LOST
  arb2L2:   'bl_arb2_l2',  // Betfair leg — WON (winning leg)
  mid1:     'br_mid1',
  mid1L1:   'bl_mid1_l1',  // Bet365 leg — WON (middle hit)
  mid1L2:   'bl_mid1_l2',  // Winamax leg — WON (middle hit)
  single1:  'br_s1',       // Bet365 — WON
  single2:  'br_s2',       // Winamax — LOST
  single3:  'br_s3',       // Betfair — PLACED
  casino1:  'br_cas1',     // Bet365 — WON
  xferIn:   'tx_xfer_in',  // TRANSFER_IN Pinnacle
  xferOut:  'tx_xfer_out', // TRANSFER_OUT Bet365 → linked a xferIn
} as const

function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

async function main() {
  console.log('🌱 Seeding database v2.1...\n')

  // ──────────────────────────────────────────
  // 1. USUARIO Y CONFIGURACIÓN
  // ──────────────────────────────────────────
  const passwordHash = await bcrypt.hash('demo1234', 12)

  const user = await prisma.user.upsert({
    where: { id: ID.user },
    update: {},
    create: {
      id:           ID.user,
      email:        'demo@surebettracker.pro',
      name:         'Demo User',
      passwordHash,
      plan:         'PRO',
      timezone:     'Europe/Madrid',
      currency:     'EUR',
      settings: {
        create: {
          primaryCurrency:    'EUR',
          defaultStake:       100,
          roundStakesTo:      1,
          onboardingCompleted: true,
          defaultChartPeriod: '30d',
        },
      },
    },
  })

  // ──────────────────────────────────────────
  // 2. BOOKMAKERS
  // Balances finales calculados estáticamente.
  // Los BookmakerTransactions debajo reflejan el historial completo.
  // ──────────────────────────────────────────
  await prisma.bookmaker.upsert({
    where: { id: ID.bet365 },
    update: {},
    create: {
      id: ID.bet365, userId: user.id,
      name: 'Bet365', country: 'GB', currency: 'EUR',
      color: '#027b5b', websiteUrl: 'https://www.bet365.com',
      status: 'ACTIVE',
      // final = 2000(init) -524(arb1,placed) -488(arb2,lost) +950(mid1,ret)
      //         -200(s1,placed) +350(s1,ret) -500(casino,placed) +680(casino,ret) -300(xfer)
      currentBalance: 1468.00,
      totalStaked:    2212.00, // sum of all stakes (incl. PLACED)
      totalReturn:    1980.00, // sum of returns from settled bets only
      totalProfit:     292.00, // -488 + 450 + 150 + 180
      operationCount: 5,
    },
  })

  await prisma.bookmaker.upsert({
    where: { id: ID.winamax },
    update: {},
    create: {
      id: ID.winamax, userId: user.id,
      name: 'Winamax', country: 'FR', currency: 'EUR',
      color: '#e8521a', websiteUrl: 'https://www.winamax.es',
      status: 'ACTIVE',
      // final = 1500(init) -500(mid1,placed) +960(mid1,ret) -100(s2,placed) -476(arb1,placed)
      currentBalance: 1384.00,
      totalStaked:    1076.00, // 476 + 500 + 100
      totalReturn:     960.00, // only mid1 returned
      totalProfit:     360.00, // +460(mid1) + (-100)(s2)
      operationCount: 3,
    },
  })

  await prisma.bookmaker.upsert({
    where: { id: ID.betfair },
    update: {},
    create: {
      id: ID.betfair, userId: user.id,
      name: 'Betfair Exchange', country: 'GB', currency: 'EUR',
      color: '#ffb80c', websiteUrl: 'https://www.betfair.es',
      status: 'ACTIVE',
      // final = 1000(init) -476(arb2,placed) +999.60(arb2,ret) -300(s3,placed)
      currentBalance: 1223.60,
      totalStaked:     776.00, // 476 + 300
      totalReturn:     999.60, // arb2 leg returned
      totalProfit:     523.60, // 999.60 - 476
      operationCount: 2,
    },
  })

  await prisma.bookmaker.upsert({
    where: { id: ID.pinnacle },
    update: {},
    create: {
      id: ID.pinnacle, userId: user.id,
      name: 'Pinnacle', country: 'CW', currency: 'EUR',
      color: '#d4281c', websiteUrl: 'https://www.pinnacle.com',
      status: 'ACTIVE',
      // final = 800(init) +300(xfer)
      currentBalance: 1100.00,
      totalStaked:       0.00,
      totalReturn:       0.00,
      totalProfit:       0.00,
      operationCount: 0,
    },
  })

  console.log('✓ Bookmakers: Bet365, Winamax, Betfair, Pinnacle')

  // ──────────────────────────────────────────
  // 3. TRANSACCIONES — DEPÓSITOS INICIALES
  // ──────────────────────────────────────────
  await prisma.bookmakerTransaction.createMany({
    skipDuplicates: true,
    data: [
      {
        id: 'tx_b365_init', bookmakerId: ID.bet365, userId: user.id,
        type: 'INITIAL_DEPOSIT', amount: 2000, balanceBefore: 0, balanceAfter: 2000,
        notes: 'Depósito inicial', createdAt: daysAgo(30),
      },
      {
        id: 'tx_win_init', bookmakerId: ID.winamax, userId: user.id,
        type: 'INITIAL_DEPOSIT', amount: 1500, balanceBefore: 0, balanceAfter: 1500,
        notes: 'Depósito inicial', createdAt: daysAgo(30),
      },
      {
        id: 'tx_bf_init', bookmakerId: ID.betfair, userId: user.id,
        type: 'INITIAL_DEPOSIT', amount: 1000, balanceBefore: 0, balanceAfter: 1000,
        notes: 'Depósito inicial', createdAt: daysAgo(30),
      },
      {
        id: 'tx_pin_init', bookmakerId: ID.pinnacle, userId: user.id,
        type: 'INITIAL_DEPOSIT', amount: 800, balanceBefore: 0, balanceAfter: 800,
        notes: 'Depósito inicial', createdAt: daysAgo(30),
      },
    ],
  })

  // ──────────────────────────────────────────
  // 4. ARB 2 — Football · Champions League (WON, liquidado hace 15 días)
  //    Bet365: Over 3.5 goles @ 2.05 stake 488 → LOST
  //    Betfair: Under 3.5 goles @ 2.10 stake 476 → WON
  //    Ganancia garantizada: +35.60€ sobre 964€ · ROI 3.69%
  // ──────────────────────────────────────────
  await prisma.betRecord.upsert({
    where: { id: ID.arb2 },
    update: {},
    create: {
      id: ID.arb2, userId: user.id,
      type: 'ARBITRAGE', status: 'WON',
      sport: 'FOOTBALL', competition: 'UEFA Champions League',
      eventName: 'Real Madrid vs Man City', eventDate: daysAgo(15),
      title: 'ARB — Over/Under 3.5 Goals · UCL',
      totalStake:      964.00,
      potentialReturn: 999.60,
      grossProfit:      35.60,
      totalReturn:     999.60,
      roi:               3.6929,
      datePlaced:  daysAgo(16),
      dateSettled: daysAgo(15),
      createdVia: 'MANUAL',
      arbitrageDetail: {
        create: {
          arbPercentage:  3.60,
          expectedReturn: 999.60,
          winningLegId:   ID.arb2L2, // Betfair Under leg
        },
      },
      legs: {
        create: [
          {
            id: ID.arb2L1, bookmakerId: ID.bet365,
            selection: 'Over 3.5 Goals', odds: 2.05,
            stake: 488.00, potentialReturn: 1000.40,
            status: 'LOST',
          },
          {
            id: ID.arb2L2, bookmakerId: ID.betfair,
            selection: 'Under 3.5 Goals', odds: 2.10,
            stake: 476.00, potentialReturn: 999.60,
            status: 'WON',
          },
        ],
      },
      allocations: {
        create: [
          {
            bookmakerId: ID.bet365,
            stakeAllocated:  488.00,
            returnAllocated:   0.00,
            profitAllocated: -488.00,
          },
          {
            bookmakerId: ID.betfair,
            stakeAllocated:  476.00,
            returnAllocated: 999.60,
            profitAllocated: 523.60,
          },
        ],
      },
    },
  })

  // Transacciones del Arb2
  await prisma.bookmakerTransaction.createMany({
    skipDuplicates: true,
    data: [
      // Bet365: placed -488 (balance 2000 → 1512), leg LOST (sin retorno)
      {
        id: 'tx_arb2_b365_placed', bookmakerId: ID.bet365, userId: user.id,
        type: 'BET_PLACED', amount: -488, balanceBefore: 2000, balanceAfter: 1512,
        referenceId: ID.arb2, referenceType: 'BetRecord', createdAt: daysAgo(16),
      },
      // Betfair: placed -476 (balance 1000 → 524)
      {
        id: 'tx_arb2_bf_placed', bookmakerId: ID.betfair, userId: user.id,
        type: 'BET_PLACED', amount: -476, balanceBefore: 1000, balanceAfter: 524,
        referenceId: ID.arb2, referenceType: 'BetRecord', createdAt: daysAgo(16),
      },
      // Betfair: return +999.60 (balance 524 → 1523.60)
      {
        id: 'tx_arb2_bf_return', bookmakerId: ID.betfair, userId: user.id,
        type: 'BET_RETURN', amount: 999.60, balanceBefore: 524, balanceAfter: 1523.60,
        referenceId: ID.arb2, referenceType: 'BetRecord', createdAt: daysAgo(15),
      },
    ],
  })

  // ──────────────────────────────────────────
  // 5. MIDDLE 1 — Basketball · NBA (WON, middle entró hace 10 días)
  //    Bet365: Lakers -3.5 @ 1.90 stake 500 → WON
  //    Winamax: Warriors +4.5 @ 1.92 stake 500 → WON
  //    Middle: Lakers ganan por exactamente 4 puntos → AMBAS PIERNAS GANAN
  //    Ganancia: +910€ sobre 1000€ stakeados · ROI 91%
  // ──────────────────────────────────────────
  await prisma.betRecord.upsert({
    where: { id: ID.mid1 },
    update: {},
    create: {
      id: ID.mid1, userId: user.id,
      type: 'MIDDLE', status: 'WON',
      sport: 'BASKETBALL', competition: 'NBA Regular Season',
      eventName: 'LA Lakers vs Golden State Warriors', eventDate: daysAgo(10),
      title: 'MIDDLE — Lakers AH · NBA',
      totalStake:       1000.00,
      potentialReturn:   950.00, // peor caso: sólo una pierna gana
      grossProfit:       910.00, // middle entró: 950 + 960 - 1000
      totalReturn:      1910.00,
      roi:                91.00,
      datePlaced:  daysAgo(11),
      dateSettled: daysAgo(10),
      createdVia: 'MANUAL',
      middleDetail: {
        create: {
          middleRange:    'Lakers ganan por exactamente 4 puntos (>3.5 y ≤4.5)',
          worstCaseLoss:  -50.00, // si sólo una pierna gana: ~950 o 960 - 1000
          bestCaseProfit: 910.00, // si el middle entra: 950 + 960 - 1000
          middleHit:      true,
          winningLegId:   null,   // null = ambas piernas ganaron
        },
      },
      legs: {
        create: [
          {
            id: ID.mid1L1, bookmakerId: ID.bet365,
            selection: 'LA Lakers -3.5 (AH)', odds: 1.90,
            stake: 500.00, potentialReturn: 950.00,
            status: 'WON',
          },
          {
            id: ID.mid1L2, bookmakerId: ID.winamax,
            selection: 'Golden State Warriors +4.5 (AH)', odds: 1.92,
            stake: 500.00, potentialReturn: 960.00,
            status: 'WON',
          },
        ],
      },
      allocations: {
        create: [
          {
            bookmakerId: ID.bet365,
            stakeAllocated:  500.00,
            returnAllocated: 950.00,
            profitAllocated: 450.00,
          },
          {
            bookmakerId: ID.winamax,
            stakeAllocated:  500.00,
            returnAllocated: 960.00,
            profitAllocated: 460.00,
          },
        ],
      },
    },
  })

  // Transacciones del Middle1
  await prisma.bookmakerTransaction.createMany({
    skipDuplicates: true,
    data: [
      // Bet365: placed -500 (1512 → 1012)
      {
        id: 'tx_mid1_b365_placed', bookmakerId: ID.bet365, userId: user.id,
        type: 'BET_PLACED', amount: -500, balanceBefore: 1512, balanceAfter: 1012,
        referenceId: ID.mid1, referenceType: 'BetRecord', createdAt: daysAgo(11),
      },
      // Bet365: return +950 (1012 → 1962)
      {
        id: 'tx_mid1_b365_return', bookmakerId: ID.bet365, userId: user.id,
        type: 'BET_RETURN', amount: 950, balanceBefore: 1012, balanceAfter: 1962,
        referenceId: ID.mid1, referenceType: 'BetRecord', createdAt: daysAgo(10),
      },
      // Winamax: placed -500 (1500 → 1000)
      {
        id: 'tx_mid1_win_placed', bookmakerId: ID.winamax, userId: user.id,
        type: 'BET_PLACED', amount: -500, balanceBefore: 1500, balanceAfter: 1000,
        referenceId: ID.mid1, referenceType: 'BetRecord', createdAt: daysAgo(11),
      },
      // Winamax: return +960 (1000 → 1960)
      {
        id: 'tx_mid1_win_return', bookmakerId: ID.winamax, userId: user.id,
        type: 'BET_RETURN', amount: 960, balanceBefore: 1000, balanceAfter: 1960,
        referenceId: ID.mid1, referenceType: 'BetRecord', createdAt: daysAgo(10),
      },
    ],
  })

  // ──────────────────────────────────────────
  // 6. SINGLE 1 — Football · Premier League (WON, hace 8 días)
  //    Bet365: Man City a ganar @ 1.75 · stake 200€ → ganancia 150€
  // ──────────────────────────────────────────
  await prisma.betRecord.upsert({
    where: { id: ID.single1 },
    update: {},
    create: {
      id: ID.single1, userId: user.id,
      type: 'SINGLE', status: 'WON',
      sport: 'FOOTBALL', competition: 'Premier League',
      eventName: 'Man City vs Arsenal', eventDate: daysAgo(8),
      title: 'Man City to win — PL',
      primaryBookmakerId: ID.bet365,
      totalStake:       200.00,
      potentialReturn:  350.00,
      grossProfit:      150.00,
      totalReturn:      350.00,
      roi:               75.00,
      datePlaced:  daysAgo(9),
      dateSettled: daysAgo(8),
      createdVia: 'MANUAL',
      singleBetDetail: {
        create: {
          selection:  'Man City to Win',
          odds:       1.75,
          marketType: 'MATCH_RESULT',
          isFreeBet:  false,
        },
      },
      allocations: {
        create: [{
          bookmakerId: ID.bet365,
          stakeAllocated:  200.00,
          returnAllocated: 350.00,
          profitAllocated: 150.00,
        }],
      },
    },
  })

  await prisma.bookmakerTransaction.createMany({
    skipDuplicates: true,
    data: [
      // Bet365: placed -200 (1962 → 1762)
      {
        id: 'tx_s1_b365_placed', bookmakerId: ID.bet365, userId: user.id,
        type: 'BET_PLACED', amount: -200, balanceBefore: 1962, balanceAfter: 1762,
        referenceId: ID.single1, referenceType: 'BetRecord', createdAt: daysAgo(9),
      },
      // Bet365: return +350 (1762 → 2112)
      {
        id: 'tx_s1_b365_return', bookmakerId: ID.bet365, userId: user.id,
        type: 'BET_RETURN', amount: 350, balanceBefore: 1762, balanceAfter: 2112,
        referenceId: ID.single1, referenceType: 'BetRecord', createdAt: daysAgo(8),
      },
    ],
  })

  // ──────────────────────────────────────────
  // 7. SINGLE 2 — Tennis · Roland Garros (LOST, hace 5 días)
  //    Winamax: Swiatek a ganar el partido @ 1.50 · stake 100€ → -100€
  // ──────────────────────────────────────────
  await prisma.betRecord.upsert({
    where: { id: ID.single2 },
    update: {},
    create: {
      id: ID.single2, userId: user.id,
      type: 'SINGLE', status: 'LOST',
      sport: 'TENNIS', competition: 'Roland Garros',
      eventName: 'Swiatek vs Sabalenka', eventDate: daysAgo(5),
      title: 'Swiatek to win — Roland Garros Final',
      primaryBookmakerId: ID.winamax,
      totalStake:       100.00,
      potentialReturn:  150.00,
      grossProfit:     -100.00,
      totalReturn:        0.00,
      roi:             -100.00,
      datePlaced:  daysAgo(6),
      dateSettled: daysAgo(5),
      createdVia: 'MANUAL',
      singleBetDetail: {
        create: {
          selection:  'Iga Swiatek to Win Match',
          odds:       1.50,
          marketType: 'MATCH_RESULT',
          isFreeBet:  false,
        },
      },
      allocations: {
        create: [{
          bookmakerId: ID.winamax,
          stakeAllocated:   100.00,
          returnAllocated:    0.00,
          profitAllocated: -100.00,
        }],
      },
    },
  })

  await prisma.bookmakerTransaction.createMany({
    skipDuplicates: true,
    data: [
      // Winamax: placed -100 (1960 → 1860). Sin retorno (perdida).
      {
        id: 'tx_s2_win_placed', bookmakerId: ID.winamax, userId: user.id,
        type: 'BET_PLACED', amount: -100, balanceBefore: 1960, balanceAfter: 1860,
        referenceId: ID.single2, referenceType: 'BetRecord', createdAt: daysAgo(6),
      },
    ],
  })

  // ──────────────────────────────────────────
  // 8. CASINO 1 — Live Roulette · Bet365 (WON, hace 3 días)
  //    Sesión de 45 min · balance inicial 500€ → balance final 680€ · +180€
  // ──────────────────────────────────────────
  await prisma.betRecord.upsert({
    where: { id: ID.casino1 },
    update: {},
    create: {
      id: ID.casino1, userId: user.id,
      type: 'CASINO', status: 'WON',
      title: 'Lightning Roulette · Bet365 Casino',
      primaryBookmakerId: ID.bet365,
      // totalStake = saldo invertido en la sesión (balance inicial de la sesión)
      totalStake:      500.00,
      potentialReturn: 500.00, // retorno base sin ganar nada
      grossProfit:     180.00,
      totalReturn:     680.00,
      roi:              36.00,
      datePlaced:  daysAgo(3),
      dateSettled: daysAgo(3),
      createdVia: 'MANUAL',
      casinoDetail: {
        create: {
          gameType:        'LIVE_CASINO',
          gameName:        'Lightning Roulette',
          sessionDuration: 45,
          initialBalance:  500.00,
          finalBalance:    680.00,
          avgBetSize:       30.00,
          numberOfBets:    38,
          bonusUsed:       false,
        },
      },
      allocations: {
        create: [{
          bookmakerId: ID.bet365,
          stakeAllocated:  500.00,
          returnAllocated: 680.00,
          profitAllocated: 180.00,
        }],
      },
    },
  })

  await prisma.bookmakerTransaction.createMany({
    skipDuplicates: true,
    data: [
      // Bet365: casino deposit -500 (2112 → 1612)
      {
        id: 'tx_cas1_b365_placed', bookmakerId: ID.bet365, userId: user.id,
        type: 'BET_PLACED', amount: -500, balanceBefore: 2112, balanceAfter: 1612,
        referenceId: ID.casino1, referenceType: 'BetRecord', createdAt: daysAgo(3),
        notes: 'Inicio sesión Lightning Roulette',
      },
      // Bet365: casino return +680 (1612 → 2292)
      {
        id: 'tx_cas1_b365_return', bookmakerId: ID.bet365, userId: user.id,
        type: 'BET_RETURN', amount: 680, balanceBefore: 1612, balanceAfter: 2292,
        referenceId: ID.casino1, referenceType: 'BetRecord', createdAt: daysAgo(3),
        notes: 'Fin sesión Lightning Roulette',
      },
    ],
  })

  // ──────────────────────────────────────────
  // 9. ARB 1 — Football · La Liga (PLACED, en juego desde hace 2 días)
  //    Bet365: Over 2.5 goles @ 1.95 stake 524 → PLACED
  //    Winamax: Under 2.5 goles @ 2.15 stake 476 → PLACED
  //    Retorno mínimo garantizado: ~1021.80€ sobre 1000€ · arb% 2.21%
  // ──────────────────────────────────────────
  await prisma.betRecord.upsert({
    where: { id: ID.arb1 },
    update: {},
    create: {
      id: ID.arb1, userId: user.id,
      type: 'ARBITRAGE', status: 'PLACED',
      sport: 'FOOTBALL', competition: 'La Liga',
      eventName: 'Athletic Club vs Sevilla', eventDate: daysAgo(0), // hoy
      title: 'ARB — Over/Under 2.5 Goles · La Liga',
      totalStake:      1000.00,
      potentialReturn: 1021.80, // min(524*1.95, 476*2.15) = min(1021.80, 1023.40)
      grossProfit:     null,
      totalReturn:     null,
      roi:             null,
      datePlaced:  daysAgo(2),
      dateSettled: null,
      createdVia: 'MANUAL',
      arbitrageDetail: {
        create: {
          arbPercentage:  2.21,
          expectedReturn: 1021.80,
          winningLegId:   null, // pendiente de resultado
        },
      },
      legs: {
        create: [
          {
            id: ID.arb1L1, bookmakerId: ID.bet365,
            selection: 'Over 2.5 Goles', odds: 1.95,
            stake: 524.00, potentialReturn: 1021.80,
            status: 'PLACED',
          },
          {
            id: ID.arb1L2, bookmakerId: ID.winamax,
            selection: 'Under 2.5 Goles', odds: 2.15,
            stake: 476.00, potentialReturn: 1023.40,
            status: 'PLACED',
          },
        ],
      },
      allocations: {
        create: [
          {
            bookmakerId: ID.bet365,
            stakeAllocated:  524.00,
            returnAllocated: null,
            profitAllocated: null,
          },
          {
            bookmakerId: ID.winamax,
            stakeAllocated:  476.00,
            returnAllocated: null,
            profitAllocated: null,
          },
        ],
      },
    },
  })

  await prisma.bookmakerTransaction.createMany({
    skipDuplicates: true,
    data: [
      // Bet365: placed -524 (2292 → 1768)
      {
        id: 'tx_arb1_b365_placed', bookmakerId: ID.bet365, userId: user.id,
        type: 'BET_PLACED', amount: -524, balanceBefore: 2292, balanceAfter: 1768,
        referenceId: ID.arb1, referenceType: 'BetRecord', createdAt: daysAgo(2),
      },
      // Winamax: placed -476 (1860 → 1384)
      {
        id: 'tx_arb1_win_placed', bookmakerId: ID.winamax, userId: user.id,
        type: 'BET_PLACED', amount: -476, balanceBefore: 1860, balanceAfter: 1384,
        referenceId: ID.arb1, referenceType: 'BetRecord', createdAt: daysAgo(2),
      },
    ],
  })

  // ──────────────────────────────────────────
  // 10. SINGLE 3 — Basketball · NBA Finals (PLACED, desde ayer)
  //     Betfair: Celtics -2.5 @ 1.91 · stake 300€ · potentialReturn 573€
  // ──────────────────────────────────────────
  await prisma.betRecord.upsert({
    where: { id: ID.single3 },
    update: {},
    create: {
      id: ID.single3, userId: user.id,
      type: 'SINGLE', status: 'PLACED',
      sport: 'BASKETBALL', competition: 'NBA Finals',
      eventName: 'Boston Celtics vs Oklahoma City Thunder', eventDate: daysAgo(0),
      title: 'Celtics -2.5 Spread · NBA Finals',
      primaryBookmakerId: ID.betfair,
      totalStake:      300.00,
      potentialReturn: 573.00,
      grossProfit:     null,
      totalReturn:     null,
      roi:             null,
      datePlaced:  daysAgo(1),
      dateSettled: null,
      createdVia: 'MANUAL',
      singleBetDetail: {
        create: {
          selection:  'Boston Celtics -2.5',
          odds:       1.91,
          marketType: 'SPREAD',
          isFreeBet:  false,
        },
      },
      allocations: {
        create: [{
          bookmakerId: ID.betfair,
          stakeAllocated:  300.00,
          returnAllocated: null,
          profitAllocated: null,
        }],
      },
    },
  })

  await prisma.bookmakerTransaction.createMany({
    skipDuplicates: true,
    data: [
      // Betfair: placed -300 (1523.60 → 1223.60)
      {
        id: 'tx_s3_bf_placed', bookmakerId: ID.betfair, userId: user.id,
        type: 'BET_PLACED', amount: -300, balanceBefore: 1523.60, balanceAfter: 1223.60,
        referenceId: ID.single3, referenceType: 'BetRecord', createdAt: daysAgo(1),
      },
    ],
  })

  // ──────────────────────────────────────────
  // 11. TRANSFERENCIA — Bet365 → Pinnacle (hace 1 día)
  //     300€ de Bet365 a Pinnacle para aprovechar cuotas de Pinnacle.
  //     El ledger muestra que el capital total no cambia.
  // ──────────────────────────────────────────
  // Primero TRANSFER_IN (Pinnacle recibe), luego TRANSFER_OUT (Bet365 envía),
  // el TRANSFER_OUT apunta al TRANSFER_IN mediante linkedTransactionId.
  const txXferIn = await prisma.bookmakerTransaction.upsert({
    where: { id: ID.xferIn },
    update: {},
    create: {
      id: ID.xferIn, bookmakerId: ID.pinnacle, userId: user.id,
      type: 'TRANSFER_IN', amount: 300, balanceBefore: 800, balanceAfter: 1100,
      notes: 'Recibido desde Bet365', createdAt: daysAgo(1),
    },
  })

  await prisma.bookmakerTransaction.upsert({
    where: { id: ID.xferOut },
    update: {},
    create: {
      id: ID.xferOut, bookmakerId: ID.bet365, userId: user.id,
      type: 'TRANSFER_OUT', amount: -300, balanceBefore: 1768, balanceAfter: 1468,
      notes: `Enviado a Pinnacle`,
      linkedTransactionId: txXferIn.id,
      createdAt: daysAgo(1),
    },
  })

  console.log('✓ Operaciones creadas: 2 arbitrajes, 1 middle, 3 singles, 1 casino, 1 transferencia')
  console.log('  Arb1 (PLACED): Athletic vs Sevilla · Over/Under 2.5 · Bet365 + Winamax')
  console.log('  Arb2 (WON +35.60€): Real Madrid vs Man City · UCL · Betfair ganó Under 3.5')
  console.log('  Middle1 (WON +910€): Lakers vs Warriors · ¡Middle entró exactamente a 4 puntos!')
  console.log('  Single1 (WON +150€): Man City to win · PL · Bet365')
  console.log('  Single2 (LOST -100€): Swiatek to win · Roland Garros · Winamax')
  console.log('  Single3 (PLACED): Celtics -2.5 · NBA Finals · Betfair')
  console.log('  Casino1 (WON +180€): Lightning Roulette · 45min · Bet365')
  console.log('  Transfer: 300€ Bet365 → Pinnacle')

  // ──────────────────────────────────────────
  // 12. API KEY
  // ──────────────────────────────────────────
  const demoKeyHash = createHash('sha256').update(DEMO_API_KEY).digest('hex')
  await prisma.apiKey.upsert({
    where: { keyHash: demoKeyHash },
    update: {},
    create: {
      userId:      user.id,
      name:        'Telegram Bot (Demo)',
      keyHash:     demoKeyHash,
      keyPrefix:   'demo1234',
      permissions: ['records:write', 'records:read', 'bookmakers:read'],
    },
  })

  // ──────────────────────────────────────────
  // RESUMEN
  // ──────────────────────────────────────────
  console.log('\n✅ Seed completado\n')
  console.log('──────────────────────────────────────────────')
  console.log('  Usuario:    demo@surebettracker.pro / demo1234')
  console.log('  Plan:       PRO')
  console.log('──────────────────────────────────────────────')
  console.log('  BANKROLL GLOBAL:')
  console.log('  Capital inicial:    €5.300,00  (2000+1500+1000+800)')
  console.log('  Capital actual:     €5.175,60  (1468+1384+1223.60+1100)')
  console.log('  Beneficio neto:       +€757,60  (arb2+mid1+s1+s2+casino1)')
  console.log('  Detalle:')
  console.log('    Arb2    +35.60€  |  Middle1  +910.00€')
  console.log('    Single1 +150.00€ |  Single2  -100.00€')
  console.log('    Casino1 +180.00€')
  console.log('──────────────────────────────────────────────')
  console.log('  Bet365   currentBalance: €1.468,00')
  console.log('  Winamax  currentBalance: €1.384,00')
  console.log('  Betfair  currentBalance: €1.223,60')
  console.log('  Pinnacle currentBalance: €1.100,00')
  console.log('──────────────────────────────────────────────')
  console.log(`  API Key: ${DEMO_API_KEY}`)
  console.log(`  Header:  Authorization: Bearer ${DEMO_API_KEY}`)
  console.log('──────────────────────────────────────────────\n')
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
