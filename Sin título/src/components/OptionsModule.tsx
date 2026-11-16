import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
  Plus,
  Trash2,
  Send,
  Layers,
  TrendingUp,
  Activity,
  Grid,
  BarChart3,
  Wrench,
  Bell,
  HelpCircle,
  AlignLeft,
  Map as MapIcon,
} from 'lucide-react';
import {
  AR_STOCKS,
  GGAL_OPTION_EXPIRIES,
  fmtNum,
  fmtPct,
  OptionChainRow,
} from '../data/marketData';
import {
  HelpTooltip,
  InsightBanner,
  ValuationGauge,
} from './DesignSystem';
import { makeMarket, FX_EASE, PricedLeg } from './options/engine';
import { InteractiveOptionPriceMap } from './options/map/InteractiveOptionPriceMap';
import { VolatilitySurface } from './options/VolatilitySurface';

export type OptionsSubView =
  | 'mapa'
  | 'estrategias'
  | 'spreads'
  | 'flujo'
  | 'cadena'
  | 'volatilidad'
  | 'armado';

interface BuilderLeg {
  id: string;
  side: 'Compra' | 'Venta';
  type: 'Call' | 'Put' | 'Subyacente';
  strike: number;
  qty: number;
  premium: number;
  iv: number;
  delta: number;
  theta: number;
}

/* ============================================================================
   DATOS FIELES A LAS CAPTURAS DE REFERENCIA (GGAL SPOT 4.900,00 · 18 DIC · 39D)
   ============================================================================ */
type StrategyFamilyId =
  | 'sugeridas'
  | 'bull_spread'
  | 'bear_spread'
  | 'mariposas'
  | 'condores'
  | 'conos'
  | 'cunas'
  | 'sinteticos'
  | 'ratios'
  | 'calendarios'
  | 'compradas'
  | 'lanzadas'
  | 'lanz_cubierto'
  | 'married_put'
  | 'collar';

interface StrategyFamilyItem {
  id: StrategyFamilyId;
  label: string;
  svgPath: string;
}

const STRATEGY_FAMILIES: StrategyFamilyItem[] = [
  { id: 'bull_spread', label: 'Bull spread', svgPath: 'M2 11 L7 11 L13 3 L18 3' },
  { id: 'bear_spread', label: 'Bear spread', svgPath: 'M2 3 L7 3 L13 11 L18 11' },
  { id: 'mariposas', label: 'Mariposas', svgPath: 'M2 11 L6 11 L10 2 L14 11 L18 11' },
  { id: 'condores', label: 'Cóndores', svgPath: 'M2 11 L5 11 L8 3 L12 3 L15 11 L18 11' },
  { id: 'conos', label: 'Conos', svgPath: 'M2 2 L10 12 L18 2' },
  { id: 'cunas', label: 'Cuñas', svgPath: 'M2 3 L7 11 L13 11 L18 3' },
  { id: 'sinteticos', label: 'Sintéticos', svgPath: 'M3 12 L17 2' },
  { id: 'ratios', label: 'Ratios', svgPath: 'M2 9 L8 9 L12 3 L18 12' },
  { id: 'calendarios', label: 'Calendarios', svgPath: 'M2 11 Q10 1 18 11' },
  { id: 'compradas', label: 'Compradas', svgPath: 'M2 11 L10 11 L18 2' },
  { id: 'lanzadas', label: 'Lanzadas', svgPath: 'M2 3 L10 3 L18 12' },
  { id: 'lanz_cubierto', label: 'Lanz. cubierto', svgPath: 'M2 12 L10 4 L18 4' },
  { id: 'married_put', label: 'Married put', svgPath: 'M2 10 L10 10 L18 2' },
  { id: 'collar', label: 'Collar', svgPath: 'M2 11 L6 11 L14 3 L18 3' },
];

interface VisualPayoffCardData {
  id: string;
  title: string;
  subtitle: string;
  note?: string;
  family: StrategyFamilyId;
  bias: 'Alcista' | 'Lateral' | 'Bajista' | 'Se mueve';
  mode: 'familia' | 'objetivo' | 'both';
  yLabels: [string, string, string];
  xLabels: string[];
  breakevenLabels?: { xPct: number; label: string }[];
  targetLinePct?: number;
  spotLinePct: number;
  // SVG normalized coordinates (0..100 in X, -1..1 in Y where 0 is zero line)
  points: { x: number; y: number }[];
  metrics: {
    label1: string;
    val1: string;
    color1: 'green' | 'white';
    label2: string;
    val2: string;
    color2: 'red' | 'white';
    label3: string;
    val3: string;
    color3: 'green' | 'red' | 'white';
    label4: string;
    val4: string;
  };
  netPrice: number;
}

const PAYOFF_CARDS_DATA: VisualPayoffCardData[] = [
  // MODO POR FAMILIA (LATERAL - Captura 2)
  {
    id: 'cono-vendido-4800',
    title: 'Cono vendido 4.800',
    subtitle: 'Gana si el papel se queda quieto. La pérdida no tiene tope',
    family: 'conos',
    bias: 'Lateral',
    mode: 'familia',
    yLabels: ['$50k', '0', '-$50k'],
    xLabels: ['$4.500', '$4.750', '$5.000', '$5.250'],
    spotLinePct: 54,
    points: [
      { x: 0, y: 0.28 },
      { x: 44, y: 0.92 },
      { x: 100, y: 0.16 },
    ],
    metrics: {
      label1: 'cobrás',
      val1: '$70.399',
      color1: 'green',
      label2: 'arriesgás',
      val2: 'sin techo',
      color2: 'red',
      label3: 'ganás hasta',
      val3: '$70.399',
      color3: 'green',
      label4: 'termina en ganancia',
      val4: '59%',
    },
    netPrice: 703.99,
  },
  {
    id: 'cono-vendido-5000',
    title: 'Cono vendido 5.000',
    subtitle: 'Gana si el papel se queda quieto. La pérdida no tiene tope',
    family: 'conos',
    bias: 'Lateral',
    mode: 'familia',
    yLabels: ['$50k', '0', '-$50k'],
    xLabels: ['$4.600', '$4.800', '$5.000', '$5.200', '$5.400'],
    spotLinePct: 45,
    points: [
      { x: 0, y: 0.04 },
      { x: 54, y: 0.85 },
      { x: 100, y: 0.14 },
    ],
    metrics: {
      label1: 'cobrás',
      val1: '$60.483',
      color1: 'green',
      label2: 'arriesgás',
      val2: 'sin techo',
      color2: 'red',
      label3: 'ganás hasta',
      val3: '$60.483',
      color3: 'green',
      label4: 'termina en ganancia',
      val4: '51%',
    },
    netPrice: 604.83,
  },
  {
    id: 'iron-condor-4200-4600-5400-5800',
    title: 'Iron condor 4.200/4.600/5.400/5.800',
    subtitle: 'Cobrás por los dos lados y las alas ponen el techo a la pérdida',
    family: 'condores',
    bias: 'Lateral',
    mode: 'familia',
    yLabels: ['$20k', '0', '-$20k'],
    xLabels: ['$4.000', '$4.500', '$5.000', '$5.500', '$6.000'],
    breakevenLabels: [
      { xPct: 24, label: '$4.422' },
      { xPct: 70, label: '$5.578' },
    ],
    spotLinePct: 43,
    points: [
      { x: 0, y: -0.82 },
      { x: 16, y: -0.82 },
      { x: 32, y: 0.75 },
      { x: 62, y: 0.75 },
      { x: 78, y: -0.82 },
      { x: 100, y: -0.82 },
    ],
    metrics: {
      label1: 'cobrás',
      val1: '$17.844',
      color1: 'green',
      label2: 'arriesgás',
      val2: '-$22.156',
      color2: 'red',
      label3: 'ganás hasta',
      val3: '$17.844',
      color3: 'green',
      label4: 'termina en ganancia',
      val4: '49%',
    },
    netPrice: 178.44,
  },
  // MODO POR OBJETIVO (ALCISTA 5500 - Capturas 4 y 5)
  {
    id: 'collar-4800-5200',
    title: 'Collar 4.800/5.200',
    subtitle: 'Piso en 4.800, techo en 5.200 · seguro gratis (lo paga el call)',
    note: 'Punta finita: la pata más chica tiene 2 lotes.',
    family: 'collar',
    bias: 'Alcista',
    mode: 'objetivo',
    yLabels: ['$20k', '0', '-$20k'],
    xLabels: ['$4.000', '$5.000', '$6.000'],
    breakevenLabels: [{ xPct: 38, label: '$4.908' }],
    spotLinePct: 37,
    targetLinePct: 60,
    points: [
      { x: 0, y: -0.45 },
      { x: 34, y: -0.45 },
      { x: 50, y: 0.88 },
      { x: 100, y: 0.88 },
    ],
    metrics: {
      label1: 'si termina ahí',
      val1: '$29.191',
      color1: 'green',
      label2: 'sobre lo arriesgado',
      val2: '270%',
      color2: 'white',
      label3: 'arriesgás',
      val3: '-$10.809',
      color3: 'red',
      label4: 'termina en ganancia',
      val4: '48%',
    },
    netPrice: 291.91,
  },
  {
    id: 'mariposa-calls-5000-5600-6200',
    title: 'Mariposa calls 5.000/5.600/6.200',
    subtitle: 'Zona de precios; máx ganancia en el strike vendido',
    family: 'mariposas',
    bias: 'Alcista',
    mode: 'objetivo',
    yLabels: ['$25k', '0', '-$25k'],
    xLabels: ['$4.000', '$5.000', '$6.000'],
    breakevenLabels: [
      { xPct: 47, label: '$5.124' },
      { xPct: 82, label: '$6.076' },
    ],
    spotLinePct: 38,
    targetLinePct: 60,
    points: [
      { x: 0, y: -0.35 },
      { x: 42, y: -0.35 },
      { x: 64, y: 0.92 },
      { x: 87, y: -0.35 },
      { x: 100, y: -0.35 },
    ],
    metrics: {
      label1: 'si termina ahí',
      val1: '$37.592',
      color1: 'green',
      label2: 'sobre lo arriesgado',
      val2: '303%',
      color2: 'white',
      label3: 'arriesgás',
      val3: '-$12.408',
      color3: 'red',
      label4: 'termina en ganancia',
      val4: '36%',
    },
    netPrice: 124.08,
  },
  {
    id: 'condor-5000-5200-5600-5800',
    title: 'Cóndor 5.000/5.200/5.600/5.800',
    subtitle: 'Zona de ganancia amplia, con separación entre las vendidas',
    note: 'Punta finita: la pata más chica tiene 2 lotes.',
    family: 'condores',
    bias: 'Alcista',
    mode: 'objetivo',
    yLabels: ['$10k', '0', '-$10k'],
    xLabels: ['$4.000', '$5.000', '$6.000'],
    breakevenLabels: [
      { xPct: 44, label: '$5.049' },
      { xPct: 72, label: '$5.751' },
    ],
    spotLinePct: 38,
    targetLinePct: 62,
    points: [
      { x: 0, y: -0.42 },
      { x: 42, y: -0.42 },
      { x: 51, y: 0.88 },
      { x: 66, y: 0.88 },
      { x: 75, y: -0.42 },
      { x: 100, y: -0.42 },
    ],
    metrics: {
      label1: 'si termina ahí',
      val1: '$15.139',
      color1: 'green',
      label2: 'sobre lo arriesgado',
      val2: '311%',
      color2: 'white',
      label3: 'arriesgás',
      val3: '-$4.861',
      color3: 'red',
      label4: 'termina en ganancia',
      val4: '34%',
    },
    netPrice: 48.61,
  },
  {
    id: 'bull-spread-calls-5000-5400',
    title: 'Bull spread calls 5.000/5.400',
    subtitle: 'Alcista con riesgo acotado',
    family: 'bull_spread',
    bias: 'Alcista',
    mode: 'both',
    yLabels: ['$20k', '0', '-$20k'],
    xLabels: ['$4.000', '$5.000', '$6.000'],
    breakevenLabels: [{ xPct: 48, label: '$5.169' }],
    spotLinePct: 38,
    targetLinePct: 62,
    points: [
      { x: 0, y: -0.68 },
      { x: 42, y: -0.68 },
      { x: 58, y: 0.85 },
      { x: 100, y: 0.85 },
    ],
    metrics: {
      label1: 'si termina ahí',
      val1: '$23.121',
      color1: 'green',
      label2: 'sobre lo arriesgado',
      val2: '137%',
      color2: 'white',
      label3: 'arriesgás',
      val3: '-$16.879',
      color3: 'red',
      label4: 'termina en ganancia',
      val4: '40%',
    },
    netPrice: 168.79,
  },
  {
    id: 'bull-spread-puts-5000-5400',
    title: 'Bull spread puts 5.000/5.400',
    subtitle: 'Alcista con riesgo acotado',
    note: 'Punta finita: la pata más chica tiene 1 lote.',
    family: 'bull_spread',
    bias: 'Alcista',
    mode: 'objetivo',
    yLabels: ['$20k', '0', '-$20k'],
    xLabels: ['$4.000', '$5.000', '$6.000'],
    breakevenLabels: [{ xPct: 48, label: '$5.174' }],
    spotLinePct: 38,
    targetLinePct: 62,
    points: [
      { x: 0, y: -0.70 },
      { x: 42, y: -0.70 },
      { x: 58, y: 0.85 },
      { x: 100, y: 0.85 },
    ],
    metrics: {
      label1: 'si termina ahí',
      val1: '$22.649',
      color1: 'green',
      label2: 'sobre lo arriesgado',
      val2: '131%',
      color2: 'white',
      label3: 'arriesgás',
      val3: '-$17.351',
      color3: 'red',
      label4: 'termina en ganancia',
      val4: '40%',
    },
    netPrice: 173.51,
  },
  {
    id: 'married-put-4600',
    title: 'Married put 4.600',
    subtitle: 'El piso cuesta TNA 32,2%',
    family: 'married_put',
    bias: 'Alcista',
    mode: 'objetivo',
    yLabels: ['$100k', '0', '-$100k'],
    xLabels: ['$4.000', '$5.000', '$6.000'],
    breakevenLabels: [{ xPct: 46, label: '$5.103' }],
    spotLinePct: 38,
    targetLinePct: 62,
    points: [
      { x: 0, y: -0.38 },
      { x: 28, y: -0.38 },
      { x: 100, y: 0.88 },
    ],
    metrics: {
      label1: 'si termina ahí',
      val1: '$39.746',
      color1: 'green',
      label2: 'sobre lo arriesgado',
      val2: '79%',
      color2: 'white',
      label3: 'arriesgás',
      val3: '-$50.254',
      color3: 'red',
      label4: 'termina en ganancia',
      val4: '43%',
    },
    netPrice: 502.54,
  },
];

interface StrategyComparisonRow {
  id: string;
  name: string;
  tag?: string;
  desc: string;
  caja: string;
  maxGan: string;
  maxPerd: string;
  ganaPierde: string;
  crece: string;
  prob: string;
  delta: string;
  porDia: string;
  relacion: string;
  empates: [string, string?];
}

const COMPARISON_TABLE_ROWS: StrategyComparisonRow[] = [
  {
    id: 'r1',
    name: 'Cono vendido 4.800',
    desc: 'Gana si el papel se queda quieto. La pérdida no tiene tope',
    caja: '70.399',
    maxGan: '70.399',
    maxPerd: 'ilim.',
    ganaPierde: '—',
    crece: '—',
    prob: '59%',
    delta: '-32',
    porDia: '644',
    relacion: '—',
    empates: ['4.096', '5.504'],
  },
  {
    id: 'r2',
    name: 'Cono vendido 5.000',
    desc: 'Gana si el papel se queda quieto. La pérdida no tiene tope',
    caja: '60.483',
    maxGan: '60.483',
    maxPerd: 'ilim.',
    ganaPierde: '—',
    crece: '—',
    prob: '51%',
    delta: '-7',
    porDia: '621',
    relacion: '—',
    empates: ['4.395', '5.605'],
  },
  {
    id: 'r3',
    name: 'Iron condor 4.200/4.600/5.400/5.800',
    tag: '1/4',
    desc: 'Cobrás por los dos lados y las alas ponen el techo a la pérdida',
    caja: '17.844',
    maxGan: '17.844',
    maxPerd: '-22.156',
    ganaPierde: '0,81x',
    crece: '-5,76%',
    prob: '49%',
    delta: '-1',
    porDia: '226',
    relacion: '—',
    empates: ['4.422', '5.578'],
  },
  {
    id: 'r4',
    name: 'Ratio call 5.000/5.400 x2',
    desc: 'Compra en el dinero, financiada vendiendo el doble más afuera. Riesgo si sube fuerte',
    caja: '3.051',
    maxGan: '43.051',
    maxPerd: 'ilim.',
    ganaPierde: '—',
    crece: '—',
    prob: '83%',
    delta: '-7',
    porDia: '259',
    relacion: '1,82',
    empates: ['5.831'],
  },
  {
    id: 'r5',
    name: 'Iron condor 4.400/4.800/5.400/5.800',
    tag: '1/4',
    desc: 'Cobrás por los dos lados y las alas ponen el techo a la pérdida',
    caja: '21.641',
    maxGan: '21.641',
    maxPerd: '-18.359',
    ganaPierde: '1,18x',
    crece: '-6,41%',
    prob: '43%',
    delta: '4',
    porDia: '196',
    relacion: '—',
    empates: ['4.584', '5.616'],
  },
  {
    id: 'r6',
    name: 'Iron condor 4.200/4.600/5.600/6.000',
    tag: '1/4',
    desc: 'Cobrás por los dos lados y las alas ponen el techo a la pérdida',
    caja: '15.308',
    maxGan: '15.308',
    maxPerd: '-24.692',
    ganaPierde: '0,62x',
    crece: '-6,07%',
    prob: '53%',
    delta: '3',
    porDia: '216',
    relacion: '—',
    empates: ['4.447', '5.753'],
  },
  {
    id: 'r7',
    name: 'Iron condor 4.400/4.800/5.600/6.000',
    tag: '1/4',
    desc: 'Cobrás por los dos lados y las alas ponen el techo a la pérdida',
    caja: '19.105',
    maxGan: '19.105',
    maxPerd: '-20.895',
    ganaPierde: '0,91x',
    crece: '-6,70%',
    prob: '47%',
    delta: '8',
    porDia: '186',
    relacion: '—',
    empates: ['4.609', '5.791'],
  },
  {
    id: 'r8',
    name: 'Iron condor 4.200/4.600/5.800/6.200',
    tag: '2/4',
    desc: 'Cobrás por los dos lados y las alas ponen el techo a la pérdida',
    caja: '13.143',
    maxGan: '13.143',
    maxPerd: '-26.857',
    ganaPierde: '0,49x',
    crece: '-6,32%',
    prob: '56%',
    delta: '7',
    porDia: '194',
    relacion: '—',
    empates: ['4.469', '5.931'],
  },
];

// MÓDULO 2: DATOS EXACTOS DE LA MATRIZ DE SPREADS (CAPTURA 6)
interface SpreadLadderRow {
  base: string;
  c4: number;
  c3: number;
  c2: number;
  c1: number;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  spotMarkerAfter?: string;
  sigmaMarkerAfter?: string;
}

const SPREAD_LADDER_ROWS: SpreadLadderRow[] = [
  { base: '4.200', c4: 3.13, c3: 1.86, c2: 1.48, c1: 1.24, p1: 1.75, p2: 2.59, p3: 3.85, p4: 5.11 },
  { base: '4.400', c4: 2.75, c3: 2.74, c2: 1.63, c1: 1.30, p1: 1.53, p2: 2.27, p3: 3.02, p4: 4.04 },
  { base: '4.600', c4: 3.12, c3: 2.25, c2: 2.24, c1: 1.33, p1: 1.56, p2: 2.07, p3: 2.78, p4: 3.59 },
  {
    base: '4.800',
    c4: 3.59,
    c3: 2.68,
    c2: 1.93,
    c1: 1.92,
    p1: 1.38,
    p2: 1.85,
    p3: 2.40,
    p4: 3.00,
    spotMarkerAfter: '4.900,00',
  },
  { base: '5.000', c4: 3.62, c3: 2.43, c2: 1.82, c1: 1.31, p1: 1.35, p2: 1.74, p3: 2.18, p4: 2.73 },
  { base: '5.200', c4: 3.70, c3: 2.83, c2: 1.90, c1: 1.42, p1: 1.36, p2: 1.70, p3: 2.13, p4: 2.83 },
  { base: '5.400', c4: 4.12, c3: 2.73, c2: 2.09, c1: 1.40, p1: 1.27, p2: 1.59, p3: 2.11, p4: 2.47 },
  {
    base: '5.600',
    c4: 4.43,
    c3: 3.04,
    c2: 2.01,
    c1: 1.54,
    p1: 1.30,
    p2: 1.72,
    p3: 2.02,
    p4: 2.24,
    sigmaMarkerAfter: '+1σ',
  },
  { base: '5.800', c4: 4.04, c3: 3.00, c2: 2.06, c1: 1.36, p1: 1.39, p2: 1.63, p3: 1.81, p4: 2.03 },
  { base: '6.000', c4: 4.70, c3: 3.08, c2: 2.29, c1: 1.57, p1: 1.36, p2: 1.51, p3: 1.70, p4: 1.89 },
  { base: '6.200', c4: 4.38, c3: 3.12, c2: 2.04, c1: 1.51, p1: 1.28, p2: 1.44, p3: 1.61, p4: 1.76 },
];

// MÓDULO 3: DATOS EXACTOS DE FLUJO BIDIRECCIONAL POR BASE (CAPTURAS 7, 8 Y 9)
interface BidirectionalFlowRow {
  base: string;
  isAtm?: boolean;
  callNetLabel: string;
  callNetDir: 'pos' | 'neg' | 'none';
  callTotalPct: number; // 0..100
  callNetHighlightPct: number; // 0..100
  putNetLabel: string;
  putNetDir: 'pos' | 'neg' | 'none';
  putTotalPct: number; // 0..100
  putNetHighlightPct: number; // 0..100
}

const BIDIRECTIONAL_FLOW_ROWS: BidirectionalFlowRow[] = [
  { base: '4.200', callNetLabel: '+77', callNetDir: 'pos', callTotalPct: 2, callNetHighlightPct: 1, putNetLabel: '+341', putNetDir: 'pos', putTotalPct: 24, putNetHighlightPct: 2 },
  { base: '4.400', callNetLabel: '—', callNetDir: 'none', callTotalPct: 1, callNetHighlightPct: 0, putNetLabel: '-2.935', putNetDir: 'neg', putTotalPct: 45, putNetHighlightPct: 9 },
  { base: '4.600', callNetLabel: '+190', callNetDir: 'pos', callTotalPct: 2, callNetHighlightPct: 1, putNetLabel: '+745', putNetDir: 'pos', putTotalPct: 21, putNetHighlightPct: 3 },
  { base: '4.800', isAtm: true, callNetLabel: '+242', callNetDir: 'pos', callTotalPct: 3, callNetHighlightPct: 2, putNetLabel: '+252', putNetDir: 'pos', putTotalPct: 23, putNetHighlightPct: 2 },
  { base: '5.000', callNetLabel: '+1.168', callNetDir: 'pos', callTotalPct: 14, callNetHighlightPct: 4, putNetLabel: '+1.852', putNetDir: 'pos', putTotalPct: 27, putNetHighlightPct: 6 },
  { base: '5.200', callNetLabel: '-156', callNetDir: 'neg', callTotalPct: 12, callNetHighlightPct: 1, putNetLabel: '+1.039', putNetDir: 'pos', putTotalPct: 9, putNetHighlightPct: 3 },
  { base: '5.400', callNetLabel: '-2.471', callNetDir: 'neg', callTotalPct: 22, callNetHighlightPct: 8, putNetLabel: '+419', putNetDir: 'pos', putTotalPct: 5, putNetHighlightPct: 2 },
  { base: '5.600', callNetLabel: '-1.413', callNetDir: 'neg', callTotalPct: 38, callNetHighlightPct: 5, putNetLabel: '-24', putNetDir: 'neg', putTotalPct: 3, putNetHighlightPct: 1 },
  { base: '5.800', callNetLabel: '-3.309', callNetDir: 'neg', callTotalPct: 31, callNetHighlightPct: 10, putNetLabel: '+452', putNetDir: 'pos', putTotalPct: 3, putNetHighlightPct: 2 },
  { base: '6.000', callNetLabel: '+1.940', callNetDir: 'pos', callTotalPct: 54, callNetHighlightPct: 6, putNetLabel: '-18', putNetDir: 'neg', putTotalPct: 1, putNetHighlightPct: 1 },
  { base: '6.200', callNetLabel: '+2.474', callNetDir: 'pos', callTotalPct: 35, callNetHighlightPct: 8, putNetLabel: '-25', putNetDir: 'neg', putTotalPct: 1, putNetHighlightPct: 1 },
  { base: '6.400', callNetLabel: '+3.345', callNetDir: 'pos', callTotalPct: 30, callNetHighlightPct: 10, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '6.600', callNetLabel: '+14', callNetDir: 'pos', callTotalPct: 19, callNetHighlightPct: 1, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '6.800', callNetLabel: '-71', callNetDir: 'neg', callTotalPct: 22, callNetHighlightPct: 1, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '7.000', callNetLabel: '+814', callNetDir: 'pos', callTotalPct: 43, callNetHighlightPct: 3, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '7.200', callNetLabel: '+2.168', callNetDir: 'pos', callTotalPct: 17, callNetHighlightPct: 7, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '7.400', callNetLabel: '-3.808', callNetDir: 'neg', callTotalPct: 19, callNetHighlightPct: 12, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '7.600', callNetLabel: '+536', callNetDir: 'pos', callTotalPct: 6, callNetHighlightPct: 2, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '7.800', callNetLabel: '+960', callNetDir: 'pos', callTotalPct: 5, callNetHighlightPct: 3, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '8.000', callNetLabel: '-350', callNetDir: 'neg', callTotalPct: 7, callNetHighlightPct: 2, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '8.300', callNetLabel: '+1.034', callNetDir: 'pos', callTotalPct: 15, callNetHighlightPct: 4, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '8.600', callNetLabel: '-387', callNetDir: 'neg', callTotalPct: 3, callNetHighlightPct: 2, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '8.900', callNetLabel: '+29', callNetDir: 'pos', callTotalPct: 2, callNetHighlightPct: 1, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '9.200', callNetLabel: '+52', callNetDir: 'pos', callTotalPct: 2, callNetHighlightPct: 1, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '9.500', callNetLabel: '-322', callNetDir: 'neg', callTotalPct: 3, callNetHighlightPct: 1, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '9.900', callNetLabel: '-405', callNetDir: 'neg', callTotalPct: 6, callNetHighlightPct: 2, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '10.300', callNetLabel: '-521', callNetDir: 'neg', callTotalPct: 16, callNetHighlightPct: 2, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '10.700', callNetLabel: '+58', callNetDir: 'pos', callTotalPct: 2, callNetHighlightPct: 1, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
  { base: '11.100', callNetLabel: '+531', callNetDir: 'pos', callTotalPct: 8, callNetHighlightPct: 2, putNetLabel: '—', putNetDir: 'none', putTotalPct: 0, putNetHighlightPct: 0 },
];

/* ============================================================================
   COMPONENTE DE TARJETA DE PAYOFF (CAPTURAS 2, 4 Y 5)
   ============================================================================ */
const PayoffStrategyCard: React.FC<{
  card: VisualPayoffCardData;
  onExecute: (card: VisualPayoffCardData) => void;
}> = ({ card, onExecute }) => {
  const clipAboveId = `clip-above-${card.id}`;
  const clipBelowId = `clip-below-${card.id}`;

  // Mapear puntos a coordenadas SVG (X: 38..288, Y cero = 74, rango Y = 22..126)
  const zeroY = 74;
  const halfSpanY = 48;
  const xStart = 38;
  const xWidth = 250;

  const svgPts = card.points.map((pt) => ({
    x: xStart + (pt.x / 100) * xWidth,
    y: zeroY - pt.y * halfSpanY,
  }));

  const polylineStr = svgPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPolygonStr = `${xStart},${zeroY} ${polylineStr} ${xStart + xWidth},${zeroY}`;
  const spotX = xStart + (card.spotLinePct / 100) * xWidth;
  const targetX = card.targetLinePct ? xStart + (card.targetLinePct / 100) * xWidth : null;

  return (
    <div className="rounded-[12px] bg-[#12141A] border border-[#232733] hover:border-[#343A4D] p-5 flex flex-col justify-between gap-4 transition-all">
      {/* Header de la Card */}
      <div className="space-y-1.5">
        <h3 className="text-[16px] font-bold text-[#FFFFFF] tracking-tight">{card.title}</h3>
        <p className="text-[12.5px] text-[#9CA3AF] leading-snug">{card.subtitle}</p>
        {card.note && (
          <p className="text-[12px] text-[#D1D4DC] pt-1 font-medium">{card.note}</p>
        )}
      </div>

      {/* Gráfico SVG de Payoff a Expiración */}
      <div className="pt-1">
        <svg viewBox="0 0 302 152" className="w-full h-36 overflow-visible">
          <defs>
            <clipPath id={clipAboveId}>
              <rect x={xStart} y="10" width={xWidth} height={zeroY - 10} />
            </clipPath>
            <clipPath id={clipBelowId}>
              <rect x={xStart} y={zeroY} width={xWidth} height="68" />
            </clipPath>
          </defs>

          {/* Líneas de grilla horizontal */}
          <line x1={xStart} y1="30" x2={xStart + xWidth} y2="30" stroke="#1E222D" strokeWidth="1" />
          <line x1={xStart} y1={zeroY} x2={xStart + xWidth} y2={zeroY} stroke="#363B4C" strokeWidth="1" />
          <line x1={xStart} y1="118" x2={xStart + xWidth} y2="118" stroke="#1E222D" strokeWidth="1" />

          {/* Etiquetas Eje Y */}
          <text x="32" y="33" textAnchor="end" fill="#787B86" fontSize="9.5" className="font-mono-num">
            {card.yLabels[0]}
          </text>
          <text x="32" y={zeroY + 3} textAnchor="end" fill="#787B86" fontSize="9.5" className="font-mono-num">
            {card.yLabels[1]}
          </text>
          <text x="32" y="121" textAnchor="end" fill="#787B86" fontSize="9.5" className="font-mono-num">
            {card.yLabels[2]}
          </text>

          {/* Área sombreada verde oscura (#0E382B) para ganancia */}
          <polygon
            points={areaPolygonStr}
            fill="#143D29"
            fillOpacity="0.82"
            clipPath={`url(#${clipAboveId})`}
          />

          {/* Área sombreada roja oscura (#381419) para pérdida */}
          <polygon
            points={areaPolygonStr}
            fill="#461B1F"
            fillOpacity="0.82"
            clipPath={`url(#${clipBelowId})`}
          />

          {/* Líneas de Breakevens (Empates) */}
          {card.breakevenLabels?.map((be) => {
            const bx = xStart + (be.xPct / 100) * xWidth;
            return (
              <g key={be.label}>
                <line x1={bx} y1="22" x2={bx} y2="128" stroke="#6D7282" strokeWidth="1" />
                <text
                  x={bx}
                  y="17"
                  textAnchor="middle"
                  fill="#9CA3AF"
                  fontSize="9.5"
                  className="font-mono-num"
                >
                  {be.label}
                </text>
              </g>
            );
          })}

          {/* Línea vertical punteada del Spot actual (4.900) */}
          <line
            x1={spotX}
            y1="20"
            x2={spotX}
            y2="128"
            stroke="#A4A8B8"
            strokeWidth="1.2"
            strokeDasharray="3 3"
          />

          {/* Línea vertical blanca sólida en el precio objetivo (si aplica) */}
          {targetX !== null && (
            <line x1={targetX} y1="20" x2={targetX} y2="128" stroke="#FFFFFF" strokeWidth="1.6" />
          )}

          {/* Curva de Payoff nítida blanca */}
          <polyline
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={polylineStr}
          />

          {/* Etiquetas Eje X */}
          {card.xLabels.map((xl, idx) => {
            const xPos =
              xStart + 22 + (idx / Math.max(1, card.xLabels.length - 1)) * (xWidth - 44);
            return (
              <text
                key={xl}
                x={xPos}
                y="144"
                textAnchor="middle"
                fill="#787B86"
                fontSize="9.5"
                className="font-mono-num"
              >
                {xl}
              </text>
            );
          })}
        </svg>
      </div>

      {/* Métricas Key-Value al pie */}
      <div className="space-y-2 pt-1 text-[13px]">
        <div className="flex items-center justify-between">
          <span className="text-[#9CA3AF]">{card.metrics.label1}</span>
          <span
            className={`font-mono-num font-bold ${
              card.metrics.color1 === 'green' ? 'text-[#22C55E]' : 'text-[#FFFFFF]'
            }`}
          >
            {card.metrics.val1}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[#9CA3AF]">{card.metrics.label2}</span>
          <span
            className={`font-mono-num font-bold ${
              card.metrics.color2 === 'red' ? 'text-[#EF4444]' : 'text-[#FFFFFF]'
            }`}
          >
            {card.metrics.val2}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[#9CA3AF]">{card.metrics.label3}</span>
          <span
            className={`font-mono-num font-bold ${
              card.metrics.color3 === 'green'
                ? 'text-[#22C55E]'
                : card.metrics.color3 === 'red'
                ? 'text-[#EF4444]'
                : 'text-[#FFFFFF]'
            }`}
          >
            {card.metrics.val3}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[#9CA3AF]">{card.metrics.label4}</span>
          <span className="font-mono-num font-bold text-[#FFFFFF]">{card.metrics.val4}</span>
        </div>
      </div>

      {/* Botón CTA "Armar esta →" */}
      <div className="pt-2 text-center">
        <button
          type="button"
          onClick={() => onExecute(card)}
          className="text-[13.5px] font-bold text-[#FFFFFF] hover:text-[#22C55E] transition-colors inline-flex items-center justify-center gap-1.5 cursor-pointer"
        >
          <span>Armar esta →</span>
        </button>
      </div>
    </div>
  );
};

/* ============================================================================
   COMPONENTE PRINCIPAL: `OptionsModule`
   ============================================================================ */
export const OptionsModule: React.FC<{
  activeSubView: OptionsSubView;
  onSelectSubView: (v: OptionsSubView) => void;
  selectedUnderlying: string;
  onSelectUnderlying: (ticker: string) => void;
  density: 'densa' | 'normal' | 'comoda';
  onOpenOrderTicket: (preset: {
    ticker: string;
    side: 'Compra' | 'Venta';
    price: number;
    qty: number;
    instrumentLabel: string;
  }) => void;
}> = ({
  activeSubView,
  onSelectSubView,
  selectedUnderlying,
  onSelectUnderlying,
  density,
  onOpenOrderTicket,
}) => {
  // Estado del Header de Opciones (Vencimiento y TLR)
  const [selectedExpiryChip, setSelectedExpiryChip] = useState<'18 dic · 39d' | '19 feb · 102d'>('18 dic · 39d');
  const [tlrRate, setTlrRate] = useState<'22,1%' | '29,8%'>('22,1%');
  const [showOnboardingBanner, setShowOnboardingBanner] = useState(true);

  // Estado del Módulo 1: Armador de Estrategias (Por familia vs Por objetivo)
  const [strategyMode, setStrategyMode] = useState<'familia' | 'objetivo'>('familia');
  const [selectedFamily, setSelectedFamily] = useState<StrategyFamilyId>('sugeridas');
  const [marketBias, setMarketBias] = useState<'Alcista' | 'Lateral' | 'Bajista' | 'Se mueve'>('Lateral');
  const [objectiveBias, setObjectiveBias] = useState<
    'Muy bajista' | 'Bajista' | 'Lateral' | 'Se mueve' | 'Alcista' | 'Muy alcista'
  >('Alcista');
  const [targetPrice, setTargetPrice] = useState<number>(5500);
  const [maxRiskInput, setMaxRiskInput] = useState<string>('sin tope');
  const [probabilityWeight, setProbabilityWeight] = useState<number>(55);

  // Estado del Módulo 2: Spreads (Escalera / Pares)
  const [spreadFilter, setSpreadFilter] = useState<'donde_estoy' | 'cerca' | 'tenencia' | 'todas'>('cerca');
  const [spreadViewMode, setSpreadViewMode] = useState<'pares' | 'escalera'>('escalera');

  // Estado del Módulo 3: Flujo por Base
  const [flowUnit, setFlowUnit] = useState<'lotes' | '$'>('lotes');
  const [flowPeriod, setFlowPeriod] = useState<'hoy' | 'anterior' | 'vencimiento'>('hoy');

  // Estado de Cadena Completa y Armado a Mano
  const [expandedExpiries, setExpandedExpiries] = useState<Record<string, boolean>>({
    JUN26: true,
    AGO26: true,
  });
  const [colMode, setColMode] = useState<'completa' | 'griegas' | 'valortiempo' | 'liquidez'>('completa');
  const [onlySigmaRange, setOnlySigmaRange] = useState(false);
  const [sigmaMultiplier, setSigmaMultiplier] = useState<1 | 1.5 | 2>(1);
  const [legs, setLegs] = useState<BuilderLeg[]>([
    {
      id: 'leg-1',
      side: 'Compra',
      type: 'Call',
      strike: 5000,
      qty: 10,
      premium: 396.0,
      iv: 51.2,
      delta: 0.51,
      theta: -7.65,
    },
    {
      id: 'leg-2',
      side: 'Venta',
      type: 'Call',
      strike: 5400,
      qty: 10,
      premium: 227.2,
      iv: 51.9,
      delta: 0.39,
      theta: -7.28,
    },
  ]);

  // Sliders de simulación en vivo del Armado a Mano (Capturas 5, 6 y 7)
  const [simSpot, setSimSpot] = useState<number>(4900);
  const [simDaysLeft, setSimDaysLeft] = useState<number>(39);
  const [simIvShift, setSimIvShift] = useState<number>(0);
  const [simTlr, setSimTlr] = useState<number>(22.1);

  const stock = useMemo(
    () => AR_STOCKS.find((s) => s.ticker === selectedUnderlying) || AR_STOCKS[0],
    [selectedUnderlying]
  );

  // Precio de referencia idéntico a la captura para GGAL (4.900,00 ARS, -1,95%)
  const displaySpot = selectedUnderlying === 'GGAL' ? 4900.0 : stock.last;
  const displayDeltaPct = selectedUnderlying === 'GGAL' ? -1.95 : stock.deltaPct;

  // Mercado compartido por Mapa, Tres maneras, Ficha y Volatilidad (sigue al VTO. y la TLR del header)
  const labMarket = useMemo(() => {
    const isDec = selectedExpiryChip.startsWith('18');
    return makeMarket(
      selectedUnderlying,
      displaySpot,
      isDec ? 39 : 102,
      tlrRate === '22,1%' ? 0.221 : 0.298,
      isDec ? '18 dic' : '19 feb',
      isDec ? 'DI' : 'FE'
    );
  }, [selectedUnderlying, displaySpot, selectedExpiryChip, tlrRate]);
  const loadIntoBuilder = (pricedLegs: PricedLeg[], units: number) => {
    setLegs(
      pricedLegs.map((l, i) => ({
        id: `lab-${Date.now()}-${i}`,
        side: l.side > 0 ? 'Compra' : 'Venta',
        type: l.type === 'C' ? 'Call' : 'Put',
        strike: l.K,
        qty: l.ratio * units,
        premium: l.premium,
        iv: +(l.iv * 100).toFixed(1),
        delta: +l.delta.toFixed(2),
        theta: +l.thetaDay.toFixed(2),
      }))
    );
    onSelectSubView('armado');
  };
  const targetSuggestedPct = (((targetPrice - displaySpot) / displaySpot) * 100).toFixed(1).replace('.', ',');

  const scaleFactor = stock.last / 6480.0;

  const scaledExpiries = useMemo(() => {
    return GGAL_OPTION_EXPIRIES.map((exp) => ({
      ...exp,
      oneSigmaLow: Math.round(exp.oneSigmaLow * scaleFactor),
      oneSigmaHigh: Math.round(exp.oneSigmaHigh * scaleFactor),
      rows: exp.rows.map((r) => {
        const sStrike = Math.round((r.strike * scaleFactor) / 50) * 50;
        return {
          ...r,
          strike: sStrike,
          callTicker: `${stock.ticker.slice(0, 3)}C${sStrike}${exp.id.slice(0, 2)}`,
          putTicker: `${stock.ticker.slice(0, 3)}V${sStrike}${exp.id.slice(0, 2)}`,
          callBid: +(r.callBid * scaleFactor).toFixed(2),
          callAsk: +(r.callAsk * scaleFactor).toFixed(2),
          callLast: +(r.callLast * scaleFactor).toFixed(2),
          callTimeValue: +(r.callTimeValue * scaleFactor).toFixed(2),
          putBid: +(r.putBid * scaleFactor).toFixed(2),
          putAsk: +(r.putAsk * scaleFactor).toFixed(2),
          putLast: +(r.putLast * scaleFactor).toFixed(2),
          putTimeValue: +(r.putTimeValue * scaleFactor).toFixed(2),
        };
      }),
    }));
  }, [scaleFactor, stock.ticker]);

  const builderPayoff = useMemo(() => {
    const strikes = [4200, 4600, 4800, 5000, 5200, 5400, 5800, 6200];
    return strikes.map((s) => {
      let totalPnl = 0;
      legs.forEach((leg) => {
        const mult = leg.side === 'Compra' ? 1 : -1;
        const contractsShares = leg.qty * 100;
        if (leg.type === 'Call') {
          const intrinsic = Math.max(0, s - leg.strike);
          totalPnl += mult * (intrinsic - leg.premium) * contractsShares;
        } else if (leg.type === 'Put') {
          const intrinsic = Math.max(0, leg.strike - s);
          totalPnl += mult * (intrinsic - leg.premium) * contractsShares;
        } else {
          totalPnl += mult * (s - leg.strike) * leg.qty;
        }
      });
      return { spot: s, pnl: totalPnl };
    });
  }, [legs]);

  const netBuilderMetrics = useMemo(() => {
    let netCash = 0;
    let netDelta = 0;
    let netTheta = 0;
    legs.forEach((l) => {
      const mult = l.side === 'Compra' ? 1 : -1;
      netCash += -mult * l.premium * l.qty * 100;
      netDelta += mult * l.delta * l.qty * 100;
      netTheta += mult * l.theta * l.qty * 100;
    });
    return { netCash, netDelta, netTheta };
  }, [legs]);

  // Filtrado de tarjetas de Payoff
  const visiblePayoffCards = useMemo(() => {
    if (strategyMode === 'objetivo') {
      return PAYOFF_CARDS_DATA.filter((c) => c.mode === 'objetivo' || c.mode === 'both');
    }
    const byMode = PAYOFF_CARDS_DATA.filter((c) => c.mode === 'familia' || c.mode === 'both');
    if (selectedFamily !== 'sugeridas') {
      const byFam = PAYOFF_CARDS_DATA.filter((c) => c.family === selectedFamily);
      if (byFam.length > 0) return byFam;
    }
    return byMode;
  }, [strategyMode, selectedFamily]);

  const subViews: { id: OptionsSubView; label: string; icon: React.ReactNode }[] = [
    { id: 'mapa', label: 'Mapa', icon: <MapIcon className="w-3.5 h-3.5" /> },
    { id: 'estrategias', label: 'Estrategias', icon: <TrendingUp className="w-3.5 h-3.5" /> },
    { id: 'spreads', label: 'Spreads', icon: <Grid className="w-3.5 h-3.5" /> },
    { id: 'flujo', label: 'Flujo', icon: <BarChart3 className="w-3.5 h-3.5" /> },
    {
      id: 'cadena',
      label: 'Cadena completa',
      icon: (
        <Layers
          className="w-3.5 h-3.5"
          style={
            {
              boxShadow: 'rgba(0, 0, 0, 0.25) 0px 4px 4px 0px',
              '--figma-make-local-effect-type': 'DROP_SHADOW',
            } as React.CSSProperties
          }
        />
      ),
    },
    { id: 'volatilidad', label: 'Volatilidad', icon: <Activity className="w-3.5 h-3.5" /> },
    { id: 'armado', label: 'Armado a mano', icon: <Wrench className="w-3.5 h-3.5" /> },
  ];

  const getSpreadPillColor = (val: number) => {
    if (val <= 1.55) {
      return 'bg-[#113523] text-[#4ADE80] border border-[#1E5638]';
    }
    if (val <= 2.18) {
      return 'bg-[#362E14] text-[#FACC15] border border-[#5A4B1C]';
    }
    return 'bg-[#3B181C] text-[#F87171] border border-[#64252C]';
  };

  const rowHeightClass =
    density === 'densa' ? 'h-8 text-[12px]' : density === 'comoda' ? 'h-11 text-[13px]' : 'h-9 text-[12px]';

  return (
    <div className="space-y-5 animate-module">
      {/* =====================================================================
          1. HEADER DEL ACTIVO SUBYACENTE Y DATOS CLAVE (IDÉNTICO CAPTURA 1)
          ===================================================================== */}
      <div className="rounded-[12px] bg-[#0D1017] border border-[#1E222D] px-5 py-3.5 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Izquierda: Logo naranja circular + Selector GGAL + Cotización en Vivo */}
          <div className="flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#FF6B00] flex items-center justify-center text-white font-extrabold text-[15px] shadow-md shrink-0">
                ✦
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <select
                    value={selectedUnderlying}
                    onChange={(e) => onSelectUnderlying(e.target.value)}
                    className="bg-transparent text-[20px] font-extrabold text-[#FFFFFF] tracking-tight outline-none cursor-pointer"
                  >
                    {['GGAL', 'YPFD', 'PAMP', 'BMA', 'COME'].map((t) => (
                      <option key={t} value={t} className="bg-[#131722] text-white">
                        {t}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-4 h-4 text-[#9CA3AF] -ml-1 pointer-events-none" />
                </div>
                <div className="text-[12px] text-[#787B86] leading-none">{stock.name}</div>
              </div>
            </div>

            {/* Cotización en Vivo: ÚLTIMO 4.900,00 ARS -1,95% */}
            <div className="flex flex-col">
              <span className="text-[10px] font-mono-num uppercase tracking-wider text-[#787B86]">
                ÚLTIMO
              </span>
              <div className="flex flex-wrap items-baseline gap-2.5">
                <span
                  className={`font-mono-num text-[22px] font-extrabold tracking-tight ${
                    displayDeltaPct < 0 ? 'text-[#F23645]' : 'text-[#22C55E]'
                  }`}
                >
                  {fmtNum(displaySpot, 2)}
                </span>
                <span className="text-[12px] font-mono-num text-[#787B86]">ARS</span>
                <span
                  className={`font-mono-num text-[13px] font-semibold ${
                    displayDeltaPct < 0 ? 'text-[#F23645]' : 'text-[#22C55E]'
                  }`}
                >
                  {displayDeltaPct > 0 ? '+' : ''}
                  {fmtNum(displayDeltaPct, 2)} %
                </span>

                <button
                  type="button"
                  title="Crear alerta de precio o volatilidad"
                  className="text-[#787B86] hover:text-[#D1D4DC] p-1 cursor-pointer"
                >
                  <Bell className="w-3.5 h-3.5" />
                </button>

                <div className="hidden md:flex items-center gap-2 text-[12px] text-[#9CA3AF]">
                  <span className="w-2 h-2 rounded-full border border-[#9CA3AF]" />
                  <span className="underline decoration-dotted underline-offset-4 text-[#D1D4DC]">
                    precios y puntas del viernes, 18:00
                  </span>
                  <span className="font-mono-num text-[#6D7282]">12:56:33</span>
                </div>
              </div>
            </div>
          </div>

          {/* Derecha: Selectores VTO., TLR y DIV. */}
          <div className="flex items-center gap-6 ml-auto">
            <div>
              <div className="text-[10px] font-mono-num uppercase tracking-wider text-[#787B86]">
                VTO.
              </div>
              <button
                type="button"
                onClick={() =>
                  setSelectedExpiryChip((v) =>
                    v === '18 dic · 39d' ? '19 feb · 102d' : '18 dic · 39d'
                  )
                }
                className="inline-flex items-center gap-1 font-mono-num text-[14px] font-bold text-[#FFFFFF] hover:text-[#EAB308] cursor-pointer"
              >
                <span>{selectedExpiryChip}</span>
                <ChevronDown className="w-3.5 h-3.5 text-[#787B86]" />
              </button>
            </div>

            <div>
              <div className="text-[10px] font-mono-num uppercase tracking-wider text-[#787B86]">
                TLR
              </div>
              <button
                type="button"
                onClick={() => setTlrRate((r) => (r === '22,1%' ? '29,8%' : '22,1%'))}
                className="inline-flex items-center gap-1 font-mono-num text-[14px] font-bold text-[#FFFFFF] hover:text-[#EAB308] cursor-pointer"
              >
                <span>{tlrRate}</span>
                <ChevronDown className="w-3.5 h-3.5 text-[#787B86]" />
              </button>
            </div>

            <div>
              <div className="text-[10px] font-mono-num uppercase tracking-wider text-[#787B86]">
                DIV.
              </div>
              <div className="font-mono-num text-[14px] font-bold text-[#787B86]">—</div>
            </div>
          </div>
        </div>

        {/* Navegación interna de los 6 módulos de Opciones */}
        <div className="pt-2.5 border-t border-[#1E222D] flex items-center justify-between gap-2 overflow-x-auto">
          <div className="flex items-center gap-1.5">
            {subViews.map((sv) => {
              const active = activeSubView === sv.id;
              return (
                <button
                  key={sv.id}
                  type="button"
                  onClick={() => onSelectSubView(sv.id)}
                  className={`relative inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12.5px] font-bold transition-colors cursor-pointer whitespace-nowrap ${
                    active
                      ? 'text-[#0B0E14]'
                      : 'text-[#9CA3AF] hover:text-[#FFFFFF] hover:bg-[#161A25]'
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="options-subview-pill"
                      className="absolute inset-0 rounded-full bg-[#EAECEF]"
                      transition={{ duration: 0.4, ease: FX_EASE }}
                    />
                  )}
                  <span className="relative inline-flex items-center gap-1.5">
                    {sv.icon}
                    <span>{sv.label}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <span className="text-[11px] font-mono-num text-[#787B86] hidden lg:inline">
            1σ hoy = $865 (±17,6% al 18 dic)
          </span>
        </div>
      </div>

      {/* =====================================================================
          2. MÓDULO 1: ARMADOR DE ESTRATEGIAS (POR FAMILIA / POR OBJETIVO)
          ===================================================================== */}
      {activeSubView === 'estrategias' && (
        <div className="space-y-6">
          {/* Banner de bienvenida (Captura 1) */}
          {showOnboardingBanner && (
            <div className="rounded-[12px] bg-[#141311] border border-[#3E3522] px-6 py-4 flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="text-[14px] font-bold text-[#FFFFFF]">
                  Primera vez en Estrategias
                </div>
                <p className="text-[13px] text-[#9CA3AF]">
                  Los armados que permite la cadena de hoy, ordenados, para abrir en el Armador o en la Planilla. ¿Te mostramos qué es cada cosa?
                </p>
              </div>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => setShowOnboardingBanner(false)}
                  className="text-[13px] text-[#9CA3AF] hover:text-white cursor-pointer"
                >
                  Ahora no
                </button>
                <button
                  type="button"
                  onClick={() => setShowOnboardingBanner(false)}
                  className="px-4 py-2 rounded-full bg-[#EAECEF] hover:bg-white text-[#0B0E14] font-bold text-[13px] cursor-pointer transition-colors"
                >
                  Ver el recorrido
                </button>
              </div>
            </div>
          )}

          {/* Título "Estrategias ?" + Segmented Control: Por familia vs Por objetivo */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <h2 className="text-[24px] font-extrabold text-[#FFFFFF] tracking-tight">
                Estrategias
              </h2>
              <HelpTooltip
                title="Armador de Estrategias"
                text="Combina bases de la cadena actual de GGAL para encontrar el mejor perfil de riesgo/retorno según tu visión."
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStrategyMode('familia')}
                className={`px-4 py-2 rounded-full text-[13px] font-bold cursor-pointer transition-all ${
                  strategyMode === 'familia'
                    ? 'bg-[#EAECEF] text-[#0B0E14]'
                    : 'text-[#9CA3AF] hover:text-white'
                }`}
              >
                Por familia
              </button>
              <button
                type="button"
                onClick={() => setStrategyMode('objetivo')}
                className={`px-4 py-2 rounded-full text-[13px] font-bold cursor-pointer transition-all ${
                  strategyMode === 'objetivo'
                    ? 'bg-[#EAECEF] text-[#0B0E14]'
                    : 'text-[#9CA3AF] hover:text-white'
                }`}
              >
                Por objetivo
              </button>
            </div>

            {/* CONTROLES MODO "POR FAMILIA" (Captura 1) */}
            {strategyMode === 'familia' && (
              <div className="space-y-4">
                <div className="flex items-center gap-1.5 text-[13px] text-[#9CA3AF]">
                  <span>Clickeá una fila y elegí dónde abrirla.</span>
                  <HelpCircle className="w-3.5 h-3.5 text-[#6D7282]" />
                </div>

                {/* Botón ancho "Sugeridas" */}
                <button
                  type="button"
                  onClick={() => setSelectedFamily('sugeridas')}
                  className={`w-full py-2.5 rounded-[8px] font-bold text-[13.5px] transition-colors cursor-pointer ${
                    selectedFamily === 'sugeridas'
                      ? 'bg-[#EAECEF] text-[#0B0E14]'
                      : 'bg-[#161922] text-[#D1D4DC] hover:bg-[#1E222E]'
                  }`}
                >
                  Sugeridas
                </button>

                {/* Grilla de 14 Familias con mini-icono vectorial de payoff */}
                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-y-3 gap-x-4 px-2 py-2">
                  {STRATEGY_FAMILIES.map((fam) => {
                    const isSelected = selectedFamily === fam.id;
                    return (
                      <button
                        key={fam.id}
                        type="button"
                        onClick={() =>
                          setSelectedFamily((prev) => (prev === fam.id ? 'sugeridas' : fam.id))
                        }
                        className={`inline-flex items-center gap-2.5 py-1.5 px-2 rounded-[8px] text-[13px] transition-colors cursor-pointer text-left ${
                          isSelected
                            ? 'bg-[#1E2330] text-[#FFFFFF] font-bold'
                            : 'text-[#9CA3AF] hover:text-[#FFFFFF]'
                        }`}
                      >
                        <svg width="20" height="14" viewBox="0 0 20 14" className="shrink-0">
                          <path
                            d={fam.svgPath}
                            fill="none"
                            stroke={isSelected ? '#22C55E' : '#787B86'}
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        <span className="truncate">{fam.label}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Filtro de Sesgo de Mercado (Pills): Tu lectura del papel */}
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <span className="text-[13px] text-[#9CA3AF]">Tu lectura del papel:</span>
                  {(['Alcista', 'Lateral', 'Bajista', 'Se mueve'] as const).map((bias) => (
                    <button
                      key={bias}
                      type="button"
                      onClick={() => setMarketBias(bias)}
                      className={`px-3.5 py-1.5 rounded-full text-[13px] font-bold transition-all cursor-pointer ${
                        marketBias === bias
                          ? 'bg-[#EAECEF] text-[#0B0E14]'
                          : 'text-[#9CA3AF] hover:text-white'
                      }`}
                    >
                      {bias}
                    </button>
                  ))}
                  <span className="text-[13px] text-[#9CA3AF] ml-2">
                    Primas <strong className="text-[#FFFFFF]">caras</strong>: la teoría cobra prima.
                  </span>
                </div>
              </div>
            )}

            {/* CONTROLES MODO "POR OBJETIVO" (Captura 4) */}
            {strategyMode === 'objetivo' && (
              <div className="space-y-4">
                <p className="text-[13.5px] text-[#9CA3AF]">
                  Decí a dónde creés que va el papel y abajo aparece lo que la cadena permite armar para llegar ahí, ordenado. El precio lo ponés vos.
                </p>

                <div className="rounded-[12px] bg-[#12141A] border border-[#232733] p-5 space-y-5">
                  {/* Presets de dirección */}
                  <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-center">
                    {(
                      [
                        { id: 'Muy bajista', icon: '↘' },
                        { id: 'Bajista', icon: '↘' },
                        { id: 'Lateral', icon: '→' },
                        { id: 'Se mueve', icon: '◁▷' },
                        { id: 'Alcista', icon: '↗' },
                        { id: 'Muy alcista', icon: '↗' },
                      ] as const
                    ).map((preset) => {
                      const active = objectiveBias === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => {
                            setObjectiveBias(preset.id);
                            if (preset.id === 'Muy bajista') setTargetPrice(4200);
                            if (preset.id === 'Bajista') setTargetPrice(4550);
                            if (preset.id === 'Lateral') setTargetPrice(4900);
                            if (preset.id === 'Se mueve') setTargetPrice(5750);
                            if (preset.id === 'Alcista') setTargetPrice(5500);
                            if (preset.id === 'Muy alcista') setTargetPrice(6100);
                          }}
                          className={`py-2 px-3 rounded-full text-[12.5px] font-bold inline-flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                            active
                              ? 'bg-[#EAECEF] text-[#0B0E14]'
                              : 'text-[#9CA3AF] hover:text-white'
                          }`}
                        >
                          <span className="font-mono-num text-[11px]">{preset.icon}</span>
                          <span>{preset.id}</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Inputs: termina en [ 5500 ] +12,2% sugerido | arriesgo hasta [ sin tope ] por lote | slider */}
                  <div className="flex flex-wrap items-center gap-4 text-[13px]">
                    <div className="flex items-center gap-2.5">
                      <span className="text-[#9CA3AF]">termina en</span>
                      <input
                        type="number"
                        step={50}
                        value={targetPrice}
                        onChange={(e) => setTargetPrice(Number(e.target.value) || 4900)}
                        className="w-28 px-3 py-1.5 rounded-[8px] bg-[#181B24] border border-[#2D3242] font-mono-num font-bold text-[#FFFFFF] text-right outline-none focus:border-[#EAECEF]"
                      />
                      <span className="font-mono-num font-semibold text-[#22C55E]">
                        {Number(targetSuggestedPct.replace(',', '.')) >= 0 ? '+' : ''}
                        {targetSuggestedPct}% sugerido
                      </span>
                    </div>

                    <div className="flex items-center gap-2.5">
                      <span className="text-[#9CA3AF]">arriesgo hasta</span>
                      <input
                        type="text"
                        value={maxRiskInput}
                        onChange={(e) => setMaxRiskInput(e.target.value)}
                        className="w-28 px-3 py-1.5 rounded-[8px] bg-[#181B24] border border-[#2D3242] font-mono-num text-[#9CA3AF] text-right outline-none focus:border-[#EAECEF]"
                      />
                      <span className="text-[#9CA3AF]">por lote</span>
                    </div>

                    <div className="flex items-center gap-3 flex-1 min-w-[240px]">
                      <span className="text-[#9CA3AF] whitespace-nowrap">más retorno</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={probabilityWeight}
                        onChange={(e) => setProbabilityWeight(Number(e.target.value))}
                        className="flex-1 accent-[#EAECEF] cursor-pointer"
                      />
                      <span className="text-[#9CA3AF] whitespace-nowrap">más probable</span>
                    </div>
                  </div>

                  <p className="text-[12.5px] text-[#9CA3AF]">
                    El vencimiento es el que tenés elegido arriba, a 39 días. Un desvío de hoy son $865: es lo que el mercado está pagando que se mueva.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* B) TARJETAS DE ESTRATEGIAS SUGERIDAS (Payoff Cards en Grid de 3 columnas) */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {visiblePayoffCards.map((card) => (
              <PayoffStrategyCard
                key={card.id}
                card={card}
                onExecute={(c) =>
                  onOpenOrderTicket({
                    ticker: c.title,
                    side: 'Compra',
                    price: c.netPrice,
                    qty: 1,
                    instrumentLabel: `${c.title} (${selectedUnderlying} · ${selectedExpiryChip})`,
                  })
                }
              />
            ))}
          </div>

          {/* C) TABLA COMPARATIVA DE ESTRATEGIAS (Captura 3) */}
          <div className="rounded-[12px] bg-[#101218] border border-[#232733] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-right text-[13px]">
                <thead>
                  <tr className="border-b border-[#232733] bg-[#0D1017] text-[11.5px] font-medium text-[#787B86]">
                    <th className="py-3 px-4 text-left">estrategia</th>
                    <th className="py-3 px-3">caja</th>
                    <th className="py-3 px-3">máx gan</th>
                    <th className="py-3 px-3">máx pérd</th>
                    <th className="py-3 px-3">gana/pierde</th>
                    <th className="py-3 px-3">crece</th>
                    <th className="py-3 px-3">prob</th>
                    <th className="py-3 px-3">Δ</th>
                    <th className="py-3 px-3">$ por día</th>
                    <th className="py-3 px-3">relación</th>
                    <th className="py-3 px-4">empates</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E222D] font-mono-num">
                  {COMPARISON_TABLE_ROWS.map((row) => (
                    <tr
                      key={row.id}
                      onClick={() =>
                        onOpenOrderTicket({
                          ticker: row.name,
                          side: 'Venta',
                          price: Number(row.caja.replace('.', '')) / 100,
                          qty: 1,
                          instrumentLabel: `${row.name} (${selectedUnderlying})`,
                        })
                      }
                      className="hover:bg-[#171B26] transition-colors cursor-pointer"
                    >
                      <td className="py-3.5 px-4 text-left font-sans">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-[#FFFFFF] text-[13.5px]">{row.name}</span>
                          {row.tag && (
                            <span className="px-1.5 py-0.5 rounded bg-[#1F2433] text-[#9CA3AF] font-mono-num text-[10.5px]">
                              {row.tag}
                            </span>
                          )}
                        </div>
                        <div className="text-[11.5px] text-[#787B86] mt-0.5">{row.desc}</div>
                      </td>
                      <td className="py-3.5 px-3 text-[#22C55E] font-semibold">{row.caja}</td>
                      <td className="py-3.5 px-3 text-[#22C55E] font-semibold">{row.maxGan}</td>
                      <td className="py-3.5 px-3 text-[#EF4444] font-semibold">{row.maxPerd}</td>
                      <td className="py-3.5 px-3 text-[#FFFFFF]">{row.ganaPierde}</td>
                      <td
                        className={`py-3.5 px-3 ${
                          row.crece.startsWith('-') ? 'text-[#EF4444]' : 'text-[#787B86]'
                        }`}
                      >
                        {row.crece}
                      </td>
                      <td className="py-3.5 px-3 text-[#FFFFFF] font-semibold">{row.prob}</td>
                      <td className="py-3.5 px-3 text-[#FFFFFF]">{row.delta}</td>
                      <td className="py-3.5 px-3 text-[#22C55E] font-semibold">{row.porDia}</td>
                      <td className="py-3.5 px-3 text-[#FFFFFF]">{row.relacion}</td>
                      <td className="py-3.5 px-4 text-[#9CA3AF] text-[12px] leading-tight">
                        <div>{row.empates[0]}</div>
                        {row.empates[1] && <div>{row.empates[1]}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          3. MÓDULO 2: MATRIZ DE SPREADS (ESCALERA / PARES — CAPTURA 6)
          ===================================================================== */}
      {activeSubView === 'spreads' && (
        <div className="space-y-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[24px] font-extrabold text-[#FFFFFF] tracking-tight">
                Spreads
              </h2>
              <HelpTooltip
                title="Matriz de Spreads en Escalera"
                text="Muestra la relación retorno/costo de armar spreads verticales de 1, 2, 3 o 4 bases de ancho en Calls (izquierda) y Puts (derecha)."
              />
            </div>
            <p className="text-[13px] text-[#9CA3AF]">
              Cada par de bases, con lo que sale armarlo y lo que puede dar.
            </p>
          </div>

          <div className="rounded-[12px] bg-[#101218] border border-[#232733] overflow-hidden">
            {/* Barra de filtros de Spreads */}
            <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 border-b border-[#232733]">
              <div className="flex items-center gap-2 flex-wrap">
                {(
                  [
                    { id: 'donde_estoy', label: 'sólo donde estoy' },
                    { id: 'cerca', label: 'cerca del precio' },
                    { id: 'tenencia', label: 'tenencia' },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setSpreadFilter(f.id)}
                    className={`px-3 py-1 rounded-full text-[12px] font-semibold border cursor-pointer transition-colors ${
                      spreadFilter === f.id
                        ? 'bg-[#1F2433] text-[#FFFFFF] border-[#3E465E]'
                        : 'bg-transparent text-[#9CA3AF] border-[#262B38] hover:text-white'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSpreadViewMode('pares')}
                  className={`px-3.5 py-1.5 rounded-full text-[12.5px] font-bold cursor-pointer ${
                    spreadViewMode === 'pares'
                      ? 'bg-[#EAECEF] text-[#0B0E14]'
                      : 'text-[#9CA3AF] hover:text-white'
                  }`}
                >
                  pares
                </button>
                <button
                  type="button"
                  onClick={() => setSpreadViewMode('escalera')}
                  className={`px-3.5 py-1.5 rounded-full text-[12.5px] font-bold cursor-pointer ${
                    spreadViewMode === 'escalera'
                      ? 'bg-[#EAECEF] text-[#0B0E14]'
                      : 'text-[#9CA3AF] hover:text-white'
                  }`}
                >
                  escalera
                </button>
              </div>
            </div>

            {/* Tabla Matricial de Escalera */}
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-center font-mono-num text-[12.5px]">
                <thead>
                  {/* Encabezado dividido: CALL (Dorado/Oliva) | BASE | PUT (Púrpura) */}
                  <tr className="border-b border-[#232733] text-[11px] font-bold uppercase tracking-wider">
                    <th colSpan={4} className="py-2.5 bg-[#2B2819] text-[#EAB308]">
                      CALL
                    </th>
                    <th className="py-2.5 bg-[#161922] text-[#9CA3AF] w-28" />
                    <th colSpan={4} className="py-2.5 bg-[#261D30] text-[#C084FC]">
                      PUT
                    </th>
                  </tr>
                  <tr className="border-b border-[#232733] bg-[#13161F] text-[11.5px] font-medium text-[#9CA3AF]">
                    <th className="py-2.5 px-3">4 bases</th>
                    <th className="py-2.5 px-3">3 bases</th>
                    <th className="py-2.5 px-3">2 bases</th>
                    <th className="py-2.5 px-3">1 base</th>
                    <th className="py-2.5 px-4 bg-[#1C202B] text-[#D1D4DC] font-semibold">
                      BASE
                    </th>
                    <th className="py-2.5 px-3">1 base</th>
                    <th className="py-2.5 px-3">2 bases</th>
                    <th className="py-2.5 px-3">3 bases</th>
                    <th className="py-2.5 px-3">4 bases</th>
                  </tr>
                </thead>
                <tbody>
                  {SPREAD_LADDER_ROWS.map((row) => {
                    const isAtmRow = row.base === '4.800';
                    return (
                      <React.Fragment key={row.base}>
                        <tr
                          className={`border-b border-[#1A1E29] ${
                            isAtmRow ? 'bg-[#1B1F2A]' : 'hover:bg-[#161A24]'
                          }`}
                        >
                          {[row.c4, row.c3, row.c2, row.c1].map((val, cIdx) => (
                            <td key={`c-${cIdx}`} className="py-2.5 px-2">
                              <button
                                type="button"
                                onClick={() =>
                                  onOpenOrderTicket({
                                    ticker: `CALL-SPREAD-${row.base}`,
                                    side: 'Compra',
                                    price: val * 100,
                                    qty: 10,
                                    instrumentLabel: `Spread Call Base ${row.base} (${4 - cIdx} bases)`,
                                  })
                                }
                                className={`px-2.5 py-0.5 rounded-full font-bold text-[12px] cursor-pointer hover:brightness-125 transition-all ${getSpreadPillColor(
                                  val
                                )}`}
                              >
                                {fmtNum(val, 2)}
                              </button>
                            </td>
                          ))}

                          {/* Columna Central: BASE */}
                          <td
                            className={`py-2.5 px-4 font-bold text-[#FFFFFF] ${
                              isAtmRow ? 'bg-[#2A2F3D]' : 'bg-[#1C202B]'
                            }`}
                          >
                            {row.base}
                          </td>

                          {[row.p1, row.p2, row.p3, row.p4].map((val, pIdx) => (
                            <td key={`p-${pIdx}`} className="py-2.5 px-2">
                              <button
                                type="button"
                                onClick={() =>
                                  onOpenOrderTicket({
                                    ticker: `PUT-SPREAD-${row.base}`,
                                    side: 'Compra',
                                    price: val * 100,
                                    qty: 10,
                                    instrumentLabel: `Spread Put Base ${row.base} (${pIdx + 1} bases)`,
                                  })
                                }
                                className={`px-2.5 py-0.5 rounded-full font-bold text-[12px] cursor-pointer hover:brightness-125 transition-all ${getSpreadPillColor(
                                  val
                                )}`}
                              >
                                {fmtNum(val, 2)}
                              </button>
                            </td>
                          ))}
                        </tr>

                        {/* Línea divisoria de Spot 4.900,00 (Captura 6) */}
                        {row.spotMarkerAfter && (
                          <tr>
                            <td colSpan={9} className="p-0 relative h-0">
                              <div className="w-full border-t border-[#EAB308]/80 relative flex justify-center items-center">
                                <span className=" -top-2.5 px-2 py-0.2 rounded-full bg-[#EAB308] text-[#0B0E14] font-mono-num font-extrabold text-[10.5px] shadow">
                                  {row.spotMarkerAfter}
                                </span>
                              </div>
                            </td>
                          </tr>
                        )}

                        {/* Línea punteada +1σ (Captura 6) */}
                        {row.sigmaMarkerAfter && (
                          <tr>
                            <td colSpan={9} className="p-0 relative h-0">
                              <div className="w-full border-t border-dashed border-[#6D7282] relative flex justify-center items-center">
                                <span className="-top-2.5 px-2 py-0.2 rounded-full bg-[#1C202B] border border-[#6D7282] text-[#D1D4DC] font-mono-num font-bold text-[10px]">
                                  {row.sigmaMarkerAfter}
                                </span>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          4. MÓDULO 3: FLUJO DE DINERO EN OPCIONES (CAPTURAS 7, 8 Y 9)
          ===================================================================== */}
      {activeSubView === 'flujo' && (
        <div className="space-y-4">
          {/* Título Flujo ? */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[24px] font-extrabold text-[#FFFFFF] tracking-tight">
                Flujo
              </h2>
              <HelpTooltip
                title="Flujo de Dinero en Opciones"
                text="Analiza si las operaciones del día se ejecutaron agrediendo la punta vendedora (compraron) o la punta compradora (vendieron)."
              />
            </div>
            <p className="text-[13px] text-[#9CA3AF]">
              De qué lado entró la mano en cada base, sumando la rueda entera.
            </p>
          </div>

          {/* A) TARJETAS RESUMEN DE SENTIMIENTO (Captura 7) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-[12px] bg-[#12141A] border border-[#232733] p-5 space-y-2">
              <div className="flex items-center gap-1.5 text-[13px] text-[#D1D4DC] font-medium">
                <span>Hacia dónde apostaron los apurados</span>
                <HelpCircle className="w-3.5 h-3.5 text-[#6D7282]" />
              </div>
              <div className="text-[22px] font-extrabold text-[#FFFFFF] tracking-tight">
                Compraron baja
              </div>
              <div className="text-[13px] text-[#9CA3AF]">
                como vender 188.819 acciones, $925,2 M
              </div>
            </div>

            <div className="rounded-[12px] bg-[#12141A] border border-[#232733] p-5 space-y-2">
              <div className="flex items-center gap-1.5 text-[13px] text-[#D1D4DC] font-medium">
                <span>Cuánto movimiento compraron</span>
                <HelpCircle className="w-3.5 h-3.5 text-[#6D7282]" />
              </div>
              <div className="text-[22px] font-extrabold text-[#FFFFFF] tracking-tight">
                Compraron volatilidad
              </div>
              <div className="text-[13px] text-[#9CA3AF]">
                ganan $1,3 M por cada punto que suba la VI
              </div>
            </div>
          </div>

          {/* Card 3: Rueda completa con barra bicolor 52% verde / 48% rojo */}
          <div className="rounded-[12px] bg-[#12141A] border border-[#232733] p-5 space-y-4">
            <div className="flex items-center gap-1.5 text-[13.5px] font-bold text-[#FFFFFF]">
              <span>Rueda completa</span>
              <HelpCircle className="w-3.5 h-3.5 text-[#6D7282]" />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <div className="text-[10.5px] font-mono-num uppercase tracking-wider text-[#787B86]">
                  LOTES OPERADOS
                </div>
                <div className="font-mono-num text-[18px] font-extrabold text-[#FFFFFF] mt-0.5">
                  192.416
                </div>
              </div>
              <div>
                <div className="text-[10.5px] font-mono-num uppercase tracking-wider text-[#787B86]">
                  EN PESOS
                </div>
                <div className="font-mono-num text-[18px] font-extrabold text-[#FFFFFF] mt-0.5">
                  $2.365,6M
                </div>
              </div>
              <div>
                <div className="text-[10.5px] font-mono-num uppercase tracking-wider text-[#787B86]">
                  OPERACIONES
                </div>
                <div className="font-mono-num text-[18px] font-extrabold text-[#FFFFFF] mt-0.5">
                  17.667
                </div>
              </div>
              <div>
                <div className="text-[10.5px] font-mono-num uppercase tracking-wider text-[#787B86]">
                  ENTRÓ COMPRANDO
                </div>
                <div className="font-mono-num text-[18px] font-extrabold text-[#22C55E] mt-0.5">
                  52%
                </div>
              </div>
            </div>

            {/* Barra de progreso bicolor */}
            <div className="w-full h-2.5 rounded-full overflow-hidden flex bg-[#232733]">
              <div style={{ width: '52%' }} className="h-full bg-[#22C55E]" />
              <div style={{ width: '48%' }} className="h-full bg-[#EF4444]" />
            </div>
          </div>

          {/* B) GRÁFICO DE BARRAS BIDIRECCIONAL POR BASE ("Por base" — Capturas 8 y 9) */}
          <div className="rounded-[12px] bg-[#101218] border border-[#232733] overflow-hidden">
            {/* Barra de herramientas superior */}
            <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 border-b border-[#232733]">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 text-[13.5px] font-bold text-[#FFFFFF]">
                  <span>Por base</span>
                  <HelpCircle className="w-3.5 h-3.5 text-[#6D7282]" />
                </div>

                <div className="flex items-center gap-1 border-l border-[#232733] pl-3">
                  <span className="p-1.5 rounded bg-[#1E2330] text-[#FFFFFF]">
                    <AlignLeft className="w-3.5 h-3.5" />
                  </span>
                </div>

                {/* Toggle lotes vs $ */}
                <div className="flex items-center gap-1 border-l border-[#232733] pl-3 text-[12.5px]">
                  <button
                    type="button"
                    onClick={() => setFlowUnit('lotes')}
                    className={`px-2.5 py-1 rounded font-bold cursor-pointer ${
                      flowUnit === 'lotes'
                        ? 'bg-[#1E2330] text-[#FFFFFF]'
                        : 'text-[#787B86] hover:text-white'
                    }`}
                  >
                    lotes
                  </button>
                  <button
                    type="button"
                    onClick={() => setFlowUnit('$')}
                    className={`px-2.5 py-1 rounded font-bold cursor-pointer ${
                      flowUnit === '$'
                        ? 'bg-[#1E2330] text-[#FFFFFF]'
                        : 'text-[#787B86] hover:text-white'
                    }`}
                  >
                    $
                  </button>
                </div>
              </div>

              {/* Toggles hoy | anterior | vencimiento */}
              <div className="flex items-center gap-1.5">
                {(['hoy', 'anterior', 'vencimiento'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setFlowPeriod(p)}
                    className={`px-3.5 py-1.5 rounded-full text-[12.5px] font-bold cursor-pointer transition-colors ${
                      flowPeriod === p
                        ? 'bg-[#EAECEF] text-[#0B0E14]'
                        : 'text-[#9CA3AF] hover:text-white'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* Encabezado simétrico: CALL | BASE | PUT */}
            <div className="grid grid-cols-11 border-b border-[#232733] text-[11px] font-bold uppercase tracking-wider text-center">
              <div className="col-span-5 py-2.5 bg-[#2B2819] text-[#EAB308]">CALL</div>
              <div className="col-span-1 py-2.5 bg-[#161922] text-[#9CA3AF]">BASE</div>
              <div className="col-span-5 py-2.5 bg-[#261D30] text-[#C084FC]">PUT</div>
            </div>

            {/* Filas desde 4.200 hasta 11.100 */}
            <div className="divide-y divide-[#1A1E29] font-mono-num text-[12px]">
              {BIDIRECTIONAL_FLOW_ROWS.map((r) => (
                <div
                  key={r.base}
                  className={`grid grid-cols-11 items-center h-9 ${
                    r.isAtm ? 'bg-[#1E222E]' : 'hover:bg-[#151922]'
                  }`}
                >
                  {/* Lado Izquierdo (CALLS): Número neto a la izquierda + barra desde el borde izquierdo de su celda */}
                  <div className="col-span-5 flex items-center h-full px-3 gap-3">
                    <span
                      className={`w-14 text-right font-bold shrink-0 ${
                        r.callNetDir === 'pos'
                          ? 'text-[#22C55E]'
                          : r.callNetDir === 'neg'
                          ? 'text-[#EF4444]'
                          : 'text-[#6D7282]'
                      }`}
                    >
                      {r.callNetLabel}
                    </span>
                    <div className="flex-1 h-5 flex items-center justify-start relative">
                      {r.callTotalPct > 0 && (
                        <div
                          style={{ width: `${r.callTotalPct}%` }}
                          className="h-5 rounded-[3px] bg-[#5E5438] relative overflow-hidden flex items-center"
                        >
                          {r.callNetHighlightPct > 0 && (
                            <div
                              style={{
                                width: `${Math.min(100, (r.callNetHighlightPct / r.callTotalPct) * 100)}%`,
                              }}
                              className={`h-full ${
                                r.callNetDir === 'pos' ? 'bg-[#22C55E]' : 'bg-[#EF4444]'
                              }`}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Columna Central: BASE */}
                  <div
                    className={`col-span-1 h-full flex items-center justify-center font-bold text-[#FFFFFF] border-x border-[#232733] ${
                      r.isAtm ? 'bg-[#2B3040]' : 'bg-[#181B24]'
                    }`}
                  >
                    {r.base}
                  </div>

                  {/* Lado Derecho (PUTS): Barra alineada a la derecha + Número neto a la derecha */}
                  <div className="col-span-5 flex items-center justify-end h-full px-3 gap-3">
                    <div className="flex-1 h-5 flex items-center justify-end relative">
                      {r.putTotalPct > 0 && (
                        <div
                          style={{ width: `${r.putTotalPct}%` }}
                          className="h-5 rounded-[3px] bg-[#564D65] relative overflow-hidden flex items-center justify-end"
                        >
                          {r.putNetHighlightPct > 0 && (
                            <div
                              style={{
                                width: `${Math.min(100, (r.putNetHighlightPct / r.putTotalPct) * 100)}%`,
                              }}
                              className={`h-full ${
                                r.putNetDir === 'pos' ? 'bg-[#22C55E]' : 'bg-[#EF4444]'
                              }`}
                            />
                          )}
                        </div>
                      )}
                    </div>
                    <span
                      className={`w-14 text-right font-bold shrink-0 ${
                        r.putNetDir === 'pos'
                          ? 'text-[#22C55E]'
                          : r.putNetDir === 'neg'
                          ? 'text-[#EF4444]'
                          : 'text-[#6D7282]'
                      }`}
                    >
                      {r.putNetLabel}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Leyenda al pie */}
            <div className="py-3 px-4 border-t border-[#232733] bg-[#0D1017] flex items-center justify-center gap-6 text-[12px] text-[#9CA3AF]">
              <span className="inline-flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-[2px] bg-[#5E5438]" />
                <span>operado</span>
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-[2px] bg-[#22C55E]" />
                <span>compraron</span>
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-[2px] bg-[#EF4444]" />
                <span>vendieron</span>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* VISTA 1: CADENA COMPLETA */}
      {activeSubView === 'cadena' && (
        <div className="space-y-3">
          {/* Barra de controles de cadena */}
          <div className="qc-card px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] flex items-center gap-1">
                <SlidersHorizontal className="w-3.5 h-3.5" /> Columnas:
              </span>
              {(
                [
                  { id: 'completa', label: 'Completa (Puntas + VI + Δ + Val)' },
                  { id: 'griegas', label: 'Griegas (Δ · Γ · Θ · Vega)' },
                  { id: 'valortiempo', label: 'Valor Tiempo y Paridad' },
                  { id: 'liquidez', label: 'Volumen e Interés Abierto' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setColMode(m.id)}
                  className={`px-2.5 py-1 rounded-[8px] text-[12px] font-medium transition-colors cursor-pointer ${
                    colMode === m.id
                      ? 'bg-[var(--surface-3)] text-[var(--text-primary)] border border-[var(--accent-primary)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--surface-2)] border border-transparent'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
                <span>Banda σ:</span>
                {([1, 1.5, 2] as const).map((sig) => (
                  <button
                    key={sig}
                    type="button"
                    onClick={() => setSigmaMultiplier(sig)}
                    className={`px-2 py-0.5 rounded font-mono-num text-[11px] cursor-pointer ${
                      sigmaMultiplier === sig
                        ? 'bg-[var(--accent-primary)] text-white font-semibold'
                        : 'bg-[var(--surface-2)] text-[var(--text-secondary)]'
                    }`}
                  >
                    ±{sig}σ
                  </button>
                ))}
              </div>
              <label className="inline-flex items-center gap-2 text-[12px] text-[var(--text-secondary)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={onlySigmaRange}
                  onChange={(e) => setOnlySigmaRange(e.target.checked)}
                  className="rounded accent-[#8B7CF6]"
                />
                <span>Solo bases dentro de ±1σ</span>
              </label>
            </div>
          </div>

          {/* Acordeones por vencimiento */}
          {scaledExpiries.map((exp) => {
            const isOpen = expandedExpiries[exp.id] ?? true;
            const filteredRows = onlySigmaRange ? exp.rows.filter((r) => r.inOneSigma) : exp.rows;

            return (
              <div key={exp.id} className="qc-card overflow-hidden">
                {/* Encabezado de acordeón con reparto Call/Put */}
                <div
                  onClick={() =>
                    setExpandedExpiries((prev) => ({ ...prev, [exp.id]: !isOpen }))
                  }
                  className="px-4 py-3 bg-[var(--surface-2)] border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-3 cursor-pointer hover:bg-[var(--surface-3)]/60 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {isOpen ? (
                      <ChevronDown className="w-4 h-4 text-[var(--text-secondary)]" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-[var(--text-secondary)]" />
                    )}
                    <span className="font-bold text-[14px] text-[var(--text-primary)]">
                      {exp.label}
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-mono-num bg-[var(--accent-subtle)] text-[var(--accent-primary)] border border-[var(--accent-primary)]/40">
                      {exp.daysToExpiry} días
                    </span>
                    <span className="text-[12px] text-[var(--text-secondary)] font-mono-num">
                      VI ATM: <strong className="text-[var(--text-primary)]">{fmtNum(exp.atmIV, 1)} %</strong>
                    </span>
                    <span className="text-[12px] text-[var(--text-secondary)] font-mono-num hidden md:inline">
                      · Sintético: <strong className="text-[var(--text-primary)]">{fmtNum(exp.syntheticRateTNA, 1)} % TNA</strong>
                    </span>
                  </div>

                  {/* Barra de reparto Call / Put */}
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono-num text-[#4BA3FF] font-semibold">
                        Calls {exp.callSharePct}%
                      </span>
                      <div className="w-28 h-2 rounded-full overflow-hidden flex bg-[var(--surface-3)]">
                        <div
                          style={{ width: `${exp.callSharePct}%` }}
                          className="bg-[#4BA3FF] h-full"
                        />
                        <div
                          style={{ width: `${exp.putSharePct}%` }}
                          className="bg-[#E5558F] h-full"
                        />
                      </div>
                      <span className="text-[11px] font-mono-num text-[#E5558F] font-semibold">
                        Puts {exp.putSharePct}%
                      </span>
                    </div>
                    <span className="text-[12px] font-mono-num text-[var(--text-secondary)]">
                      Vol: <strong className="text-[var(--text-primary)]">$ {fmtNum(exp.totalVolumeM, 0)} M</strong>
                    </span>
                  </div>
                </div>

                {isOpen && (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-right">
                      <thead>
                        <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)] text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                          <th
                            colSpan={colMode === 'completa' ? 7 : 6}
                            className="py-1.5 px-3 text-left text-[#4BA3FF] bg-[#0B1A2C]/60 border-r border-[var(--border-subtle)]"
                          >
                            CALLS (Compra / Lanzamiento Alcista) — Click en punta para operar
                          </th>
                          <th className="py-1.5 px-3 text-center bg-[var(--surface-2)] text-[var(--text-primary)]">
                            BASE / DIST.
                          </th>
                          <th
                            colSpan={colMode === 'completa' ? 7 : 6}
                            className="py-1.5 px-3 text-right text-[#E5558F] bg-[#2A1124]/60 border-l border-[var(--border-subtle)]"
                          >
                            PUTS (Cobertura / Venta de Volatilidad) — Click en punta para operar
                          </th>
                        </tr>
                        <tr className="border-b border-[var(--border-subtle)] bg-[var(--surface-1)] text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                          {/* CALL HEADERS */}
                          <th className="py-2 px-2.5 text-left">Especie</th>
                          {colMode === 'completa' && (
                            <>
                              <th className="py-2 px-2">Valuación</th>
                              <th className="py-2 px-2">Delta Δ</th>
                              <th className="py-2 px-2">VI %</th>
                              <th className="py-2 px-2">Último / Δ%</th>
                              <th className="py-2 px-2 text-[#4BA3FF]">Compra (Bid)</th>
                              <th className="py-2 px-2.5 text-[#4BA3FF] border-r border-[var(--border-subtle)]">
                                Venta (Ask)
                              </th>
                            </>
                          )}
                          {colMode === 'griegas' && (
                            <>
                              <th className="py-2 px-2">VI %</th>
                              <th className="py-2 px-2">Delta Δ</th>
                              <th className="py-2 px-2">Gamma Γ</th>
                              <th className="py-2 px-2">Theta Θ (d)</th>
                              <th className="py-2 px-2.5 border-r border-[var(--border-subtle)]">Vega ν</th>
                            </>
                          )}
                          {colMode === 'valortiempo' && (
                            <>
                              <th className="py-2 px-2">Último</th>
                              <th className="py-2 px-2">Val. Intrínseco</th>
                              <th className="py-2 px-2">Val. Tiempo $</th>
                              <th className="py-2 px-2">Tasa % s/Spot</th>
                              <th className="py-2 px-2.5 border-r border-[var(--border-subtle)]">Cara/Barata</th>
                            </>
                          )}
                          {colMode === 'liquidez' && (
                            <>
                              <th className="py-2 px-2">Lotes Hoy</th>
                              <th className="py-2 px-2">Int. Abierto</th>
                              <th className="py-2 px-2">Rotación OI</th>
                              <th className="py-2 px-2">Bid</th>
                              <th className="py-2 px-2.5 border-r border-[var(--border-subtle)]">Ask</th>
                            </>
                          )}

                          {/* STRIKE CENTER */}
                          <th className="py-2 px-3 text-center bg-[var(--surface-2)] text-[var(--text-primary)]">
                            Strike ($)
                          </th>

                          {/* PUT HEADERS */}
                          {colMode === 'completa' && (
                            <>
                              <th className="py-2 px-2.5 text-[#E5558F] border-l border-[var(--border-subtle)]">
                                Compra (Bid)
                              </th>
                              <th className="py-2 px-2 text-[#E5558F]">Venta (Ask)</th>
                              <th className="py-2 px-2">Último / Δ%</th>
                              <th className="py-2 px-2">VI %</th>
                              <th className="py-2 px-2">Delta Δ</th>
                              <th className="py-2 px-2">Valuación</th>
                            </>
                          )}
                          {colMode === 'griegas' && (
                            <>
                              <th className="py-2 px-2.5 border-l border-[var(--border-subtle)]">VI %</th>
                              <th className="py-2 px-2">Delta Δ</th>
                              <th className="py-2 px-2">Gamma Γ</th>
                              <th className="py-2 px-2">Theta Θ (d)</th>
                              <th className="py-2 px-2">Vega ν</th>
                            </>
                          )}
                          {colMode === 'valortiempo' && (
                            <>
                              <th className="py-2 px-2.5 border-l border-[var(--border-subtle)]">Último</th>
                              <th className="py-2 px-2">Val. Intrínseco</th>
                              <th className="py-2 px-2">Val. Tiempo $</th>
                              <th className="py-2 px-2">Tasa % s/Spot</th>
                              <th className="py-2 px-2">Cara/Barata</th>
                            </>
                          )}
                          {colMode === 'liquidez' && (
                            <>
                              <th className="py-2 px-2.5 border-l border-[var(--border-subtle)]">Bid</th>
                              <th className="py-2 px-2">Ask</th>
                              <th className="py-2 px-2">Lotes Hoy</th>
                              <th className="py-2 px-2">Int. Abierto</th>
                              <th className="py-2 px-2">Rotación OI</th>
                            </>
                          )}
                          <th className="py-2 px-2.5 text-right">Especie</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border-subtle)] font-mono-num">
                        {filteredRows.map((row: OptionChainRow, idx: number) => {
                          const isAtm = Math.abs(row.distancePct) < 2.0;
                          const callItm = row.strike < stock.last;
                          const putItm = row.strike > stock.last;
                          const prevRow = filteredRows[idx - 1];
                          const showSpotDividerAfter =
                            row.strike <= stock.last &&
                            filteredRows[idx + 1] &&
                            filteredRows[idx + 1].strike > stock.last;
                          const showLowSigmaBefore =
                            !prevRow?.inOneSigma && row.inOneSigma;
                          const showHighSigmaAfter =
                            row.inOneSigma && filteredRows[idx + 1] && !filteredRows[idx + 1].inOneSigma;

                          return (
                            <React.Fragment key={row.strike}>
                              {showLowSigmaBefore && (
                                <tr className="bg-[var(--surface-2)]/80">
                                  <td
                                    colSpan={15}
                                    className="py-1 px-4 text-center text-[10px] font-mono-num uppercase tracking-wider text-[#8B7CF6] border-y border-dashed border-[#8B7CF6]/40"
                                  >
                                    ── Límite Inferior −{sigmaMultiplier}σ ($ {fmtNum(exp.oneSigmaLow, 0)}) · 68,2 % de probabilidad implícita ──
                                  </td>
                                </tr>
                              )}

                              <tr
                                className={`${rowHeightClass} hover:bg-[var(--surface-2)] transition-colors ${
                                  isAtm ? 'bg-[var(--accent-subtle)]/25' : ''
                                }`}
                              >
                                {/* CALL SIDE */}
                                <td
                                  className={`px-2.5 text-left font-semibold text-[#4BA3FF] ${
                                    callItm ? 'bg-[#0B1A2C]/45' : ''
                                  }`}
                                >
                                  {row.callTicker}
                                </td>

                                {colMode === 'completa' && (
                                  <>
                                    <td className={`px-2 ${callItm ? 'bg-[#0B1A2C]/45' : ''}`}>
                                      <ValuationGauge rank={row.callValRank} />
                                    </td>
                                    <td className={`px-2 text-[var(--text-secondary)] ${callItm ? 'bg-[#0B1A2C]/45' : ''}`}>
                                      {fmtNum(row.callDelta, 2)}
                                    </td>
                                    <td className={`px-2 text-[var(--text-primary)] ${callItm ? 'bg-[#0B1A2C]/45' : ''}`}>
                                      {fmtNum(row.callIV, 1)}%
                                    </td>
                                    <td className={`px-2 ${callItm ? 'bg-[#0B1A2C]/45' : ''}`}>
                                      <div className="flex items-center justify-end gap-1.5">
                                        <span className="font-semibold text-[var(--text-primary)]">
                                          $ {fmtNum(row.callLast, 1)}
                                        </span>
                                        <span className="text-[10px] text-[#2EDC7E]">
                                          +{fmtNum(row.callDeltaPct, 1)}%
                                        </span>
                                      </div>
                                    </td>
                                    <td
                                      onClick={() =>
                                        onOpenOrderTicket({
                                          ticker: row.callTicker,
                                          side: 'Venta',
                                          price: row.callBid,
                                          qty: 10,
                                          instrumentLabel: `Call ${stock.ticker} Base ${row.strike} (${exp.id})`,
                                        })
                                      }
                                      title="Click para vender en Bid"
                                      className="px-2 bg-[#0F2641]/45 hover:bg-[#0F2641] text-[#4BA3FF] font-semibold cursor-pointer transition-colors"
                                    >
                                      $ {fmtNum(row.callBid, 1)}
                                    </td>
                                    <td
                                      onClick={() =>
                                        onOpenOrderTicket({
                                          ticker: row.callTicker,
                                          side: 'Compra',
                                          price: row.callAsk,
                                          qty: 10,
                                          instrumentLabel: `Call ${stock.ticker} Base ${row.strike} (${exp.id})`,
                                        })
                                      }
                                      title="Click para comprar en Ask"
                                      className="px-2.5 bg-[#0F2641]/75 hover:bg-[#4BA3FF] hover:text-black text-[#4BA3FF] font-semibold border-r border-[var(--border-subtle)] cursor-pointer transition-colors"
                                    >
                                      $ {fmtNum(row.callAsk, 1)}
                                    </td>
                                  </>
                                )}

                                {colMode === 'griegas' && (
                                  <>
                                    <td className="px-2">{fmtNum(row.callIV, 1)}%</td>
                                    <td className="px-2 text-[#4BA3FF] font-semibold">{fmtNum(row.callDelta, 2)}</td>
                                    <td className="px-2 text-[var(--text-secondary)]">{fmtNum(row.callGamma, 5)}</td>
                                    <td className="px-2 text-[#FF5C63]">−$ {fmtNum(Math.abs(row.callTheta), 2)}</td>
                                    <td className="px-2.5 border-r border-[var(--border-subtle)] text-[var(--text-secondary)]">
                                      $ {fmtNum(row.callVega, 2)}
                                    </td>
                                  </>
                                )}

                                {colMode === 'valortiempo' && (
                                  <>
                                    <td className="px-2 font-semibold">$ {fmtNum(row.callLast, 1)}</td>
                                    <td className="px-2 text-[var(--text-secondary)]">
                                      $ {fmtNum(Math.max(0, stock.last - row.strike), 1)}
                                    </td>
                                    <td className="px-2 text-[#4BA3FF]">$ {fmtNum(row.callTimeValue, 1)}</td>
                                    <td className="px-2 font-semibold text-[#2EDC7E]">
                                      +{fmtNum(row.callTimeValuePct, 2)} %
                                    </td>
                                    <td className="px-2.5 border-r border-[var(--border-subtle)]">
                                      <ValuationGauge rank={row.callValRank} />
                                    </td>
                                  </>
                                )}

                                {colMode === 'liquidez' && (
                                  <>
                                    <td className="px-2 font-semibold">{row.callVolumeLots.toLocaleString('es-AR')}</td>
                                    <td className="px-2 text-[var(--text-secondary)]">
                                      {row.callOpenInterest.toLocaleString('es-AR')}
                                    </td>
                                    <td className="px-2 text-[var(--text-secondary)]">
                                      {fmtNum((row.callVolumeLots / row.callOpenInterest) * 100, 1)}%
                                    </td>
                                    <td className="px-2 text-[#4BA3FF]">$ {fmtNum(row.callBid, 1)}</td>
                                    <td className="px-2.5 border-r border-[var(--border-subtle)] text-[#4BA3FF]">
                                      $ {fmtNum(row.callAsk, 1)}
                                    </td>
                                  </>
                                )}

                                {/* STRIKE CENTRAL */}
                                <td className="px-3 text-center bg-[var(--surface-2)] font-bold text-[var(--text-primary)]">
                                  <div className="flex flex-col items-center leading-tight">
                                    <span>$ {fmtNum(row.strike, 0)}</span>
                                    <span
                                      className={`text-[10px] font-normal ${
                                        row.distancePct >= 0
                                          ? 'text-[#2EDC7E]'
                                          : 'text-[var(--text-tertiary)]'
                                      }`}
                                    >
                                      {row.distancePct >= 0 ? '+' : ''}
                                      {fmtNum(row.distancePct, 1)}%
                                    </span>
                                  </div>
                                </td>

                                {/* PUT SIDE */}
                                {colMode === 'completa' && (
                                  <>
                                    <td
                                      onClick={() =>
                                        onOpenOrderTicket({
                                          ticker: row.putTicker,
                                          side: 'Venta',
                                          price: row.putBid,
                                          qty: 10,
                                          instrumentLabel: `Put ${stock.ticker} Base ${row.strike} (${exp.id})`,
                                        })
                                      }
                                      title="Click para vender Put en Bid"
                                      className="px-2.5 bg-[#3A1631]/45 hover:bg-[#3A1631] text-[#E5558F] font-semibold border-l border-[var(--border-subtle)] cursor-pointer transition-colors"
                                    >
                                      $ {fmtNum(row.putBid, 1)}
                                    </td>
                                    <td
                                      onClick={() =>
                                        onOpenOrderTicket({
                                          ticker: row.putTicker,
                                          side: 'Compra',
                                          price: row.putAsk,
                                          qty: 10,
                                          instrumentLabel: `Put ${stock.ticker} Base ${row.strike} (${exp.id})`,
                                        })
                                      }
                                      title="Click para comprar Put en Ask"
                                      className="px-2 bg-[#3A1631]/75 hover:bg-[#E5558F] hover:text-black text-[#E5558F] font-semibold cursor-pointer transition-colors"
                                    >
                                      $ {fmtNum(row.putAsk, 1)}
                                    </td>
                                    <td className={`px-2 ${putItm ? 'bg-[#2A1124]/45' : ''}`}>
                                      <div className="flex items-center justify-end gap-1.5">
                                        <span className="font-semibold text-[var(--text-primary)]">
                                          $ {fmtNum(row.putLast, 1)}
                                        </span>
                                        <span className="text-[10px] text-[#FF5C63]">
                                          {fmtNum(row.putDeltaPct, 1)}%
                                        </span>
                                      </div>
                                    </td>
                                    <td className={`px-2 text-[var(--text-primary)] ${putItm ? 'bg-[#2A1124]/45' : ''}`}>
                                      {fmtNum(row.putIV, 1)}%
                                    </td>
                                    <td className={`px-2 text-[var(--text-secondary)] ${putItm ? 'bg-[#2A1124]/45' : ''}`}>
                                      {fmtNum(row.putDelta, 2)}
                                    </td>
                                    <td className={`px-2 ${putItm ? 'bg-[#2A1124]/45' : ''}`}>
                                      <ValuationGauge rank={row.putValRank} />
                                    </td>
                                  </>
                                )}

                                {colMode === 'griegas' && (
                                  <>
                                    <td className="px-2.5 border-l border-[var(--border-subtle)]">
                                      {fmtNum(row.putIV, 1)}%
                                    </td>
                                    <td className="px-2 text-[#E5558F] font-semibold">{fmtNum(row.putDelta, 2)}</td>
                                    <td className="px-2 text-[var(--text-secondary)]">{fmtNum(row.putGamma, 5)}</td>
                                    <td className="px-2 text-[#FF5C63]">−$ {fmtNum(Math.abs(row.putTheta), 2)}</td>
                                    <td className="px-2 text-[var(--text-secondary)]">$ {fmtNum(row.putVega, 2)}</td>
                                  </>
                                )}

                                {colMode === 'valortiempo' && (
                                  <>
                                    <td className="px-2.5 border-l border-[var(--border-subtle)] font-semibold">
                                      $ {fmtNum(row.putLast, 1)}
                                    </td>
                                    <td className="px-2 text-[var(--text-secondary)]">
                                      $ {fmtNum(Math.max(0, row.strike - stock.last), 1)}
                                    </td>
                                    <td className="px-2 text-[#E5558F]">$ {fmtNum(row.putTimeValue, 1)}</td>
                                    <td className="px-2 text-[var(--text-secondary)]">
                                      {fmtNum(row.putTimeValuePct, 2)} %
                                    </td>
                                    <td className="px-2">
                                      <ValuationGauge rank={row.putValRank} />
                                    </td>
                                  </>
                                )}

                                {colMode === 'liquidez' && (
                                  <>
                                    <td className="px-2.5 border-l border-[var(--border-subtle)] text-[#E5558F]">
                                      $ {fmtNum(row.putBid, 1)}
                                    </td>
                                    <td className="px-2 text-[#E5558F]">$ {fmtNum(row.putAsk, 1)}</td>
                                    <td className="px-2 font-semibold">{row.putVolumeLots.toLocaleString('es-AR')}</td>
                                    <td className="px-2 text-[var(--text-secondary)]">
                                      {row.putOpenInterest.toLocaleString('es-AR')}
                                    </td>
                                    <td className="px-2 text-[var(--text-secondary)]">
                                      {fmtNum((row.putVolumeLots / row.putOpenInterest) * 100, 1)}%
                                    </td>
                                  </>
                                )}

                                <td
                                  className={`px-2.5 text-right font-semibold text-[#E5558F] ${
                                    putItm ? 'bg-[#2A1124]/45' : ''
                                  }`}
                                >
                                  {row.putTicker}
                                </td>
                              </tr>

                              {showSpotDividerAfter && (
                                <tr className="bg-[#241F48]/70">
                                  <td
                                    colSpan={15}
                                    className="py-1 px-4 text-center text-[11px] font-mono-num font-semibold text-white border-y border-[#8B7CF6]"
                                  >
                                    ◆ SPOT {stock.ticker} CONTADO: $ {fmtNum(stock.last, 2)} ({fmtPct(stock.deltaPct)}) · Paridad Sintética Jun: $ {fmtNum(stock.last * 1.036, 0)} ◆
                                  </td>
                                </tr>
                              )}

                              {showHighSigmaAfter && (
                                <tr className="bg-[var(--surface-2)]/80">
                                  <td
                                    colSpan={15}
                                    className="py-1 px-4 text-center text-[10px] font-mono-num uppercase tracking-wider text-[#8B7CF6] border-y border-dashed border-[#8B7CF6]/40"
                                  >
                                    ── Límite Superior +{sigmaMultiplier}σ ($ {fmtNum(exp.oneSigmaHigh, 0)}) · 68,2 % de probabilidad implícita ──
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* SUITE AVANZADA: Mapa (+ Tres maneras + Ficha) · Volatilidad, con transición entre vistas */}
      <AnimatePresence mode="wait">
        {(activeSubView === 'mapa' || activeSubView === 'volatilidad') && (
          <motion.div
            key={activeSubView}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.35, ease: FX_EASE }}
          >
            {activeSubView === 'mapa' && (
              <InteractiveOptionPriceMap
                mkt={labMarket}
                onGoToBuilder={loadIntoBuilder}
                onGoToSheet={() => onSelectSubView('cadena')}
              />
            )}
            {activeSubView === 'volatilidad' && <VolatilitySurface mkt={labMarket} />}
          </motion.div>
        )}
      </AnimatePresence>

      {/* VISTA 6: ARMADO A MANO (SIMULADOR INTERACTIVO DE PATAS) */}
      {activeSubView === 'armado' && (
        <div className="space-y-5">
          {/* =================================================================
              A) SELECTOR DE PATAS, PRESETS Y TABLA DE ARMADO DE 12 COLUMNAS
              ================================================================= */}
          <div className="rounded-[12px] bg-[#12141A] border border-[#232733] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-bold text-[#FFFFFF] mr-1">Agregar pata:</span>
                <button
                  type="button"
                  onClick={() =>
                    setLegs((prev) => [
                      ...prev,
                      {
                        id: `leg-c-${Date.now()}`,
                        side: 'Compra',
                        type: 'Call',
                        strike: 5200,
                        qty: 10,
                        premium: 312.5,
                        iv: 51.6,
                        delta: 0.45,
                        theta: -7.42,
                      },
                    ])
                  }
                  className="px-3 py-1.5 rounded-[8px] text-[12px] font-mono-num font-bold bg-[#2B2819] hover:bg-[#3A3621] text-[#EAB308] border border-[#4D4628] cursor-pointer transition-colors"
                >
                  + CALL
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setLegs((prev) => [
                      ...prev,
                      {
                        id: `leg-p-${Date.now()}`,
                        side: 'Compra',
                        type: 'Put',
                        strike: 4800,
                        qty: 10,
                        premium: 218.0,
                        iv: 52.4,
                        delta: -0.42,
                        theta: -6.15,
                      },
                    ])
                  }
                  className="px-3 py-1.5 rounded-[8px] text-[12px] font-mono-num font-bold bg-[#261D30] hover:bg-[#352844] text-[#C084FC] border border-[#48355C] cursor-pointer transition-colors"
                >
                  + PUT
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setLegs((prev) => [
                      ...prev,
                      {
                        id: `leg-s-${Date.now()}`,
                        side: 'Compra',
                        type: 'Subyacente',
                        strike: 4900,
                        qty: 1000,
                        premium: 4900.0,
                        iv: 0,
                        delta: 1.0,
                        theta: 0,
                      },
                    ])
                  }
                  className="px-3 py-1.5 rounded-[8px] text-[12px] font-mono-num font-bold bg-[#1A2234] hover:bg-[#232E47] text-[#38BDF8] border border-[#2E3D5C] cursor-pointer transition-colors"
                >
                  + ACCIÓN
                </button>
              </div>

              {/* Presets rápidos de figuras */}
              <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                <span className="text-[#787B86] mr-1">Presets:</span>
                {[
                  {
                    label: 'Bull spread',
                    preset: [
                      { id: 'p1', side: 'Compra' as const, type: 'Call' as const, strike: 5000, qty: 10, premium: 396.0, iv: 51.2, delta: 0.51, theta: -7.65 },
                      { id: 'p2', side: 'Venta' as const, type: 'Call' as const, strike: 5400, qty: 10, premium: 227.2, iv: 51.9, delta: 0.39, theta: -7.28 },
                    ],
                  },
                  {
                    label: 'Bear spread',
                    preset: [
                      { id: 'p1', side: 'Compra' as const, type: 'Put' as const, strike: 5000, qty: 10, premium: 310.0, iv: 52.8, delta: -0.52, theta: -6.4 },
                      { id: 'p2', side: 'Venta' as const, type: 'Put' as const, strike: 4600, qty: 10, premium: 148.0, iv: 53.6, delta: -0.31, theta: -5.2 },
                    ],
                  },
                  {
                    label: 'Mariposa',
                    preset: [
                      { id: 'p1', side: 'Compra' as const, type: 'Call' as const, strike: 4600, qty: 10, premium: 580.0, iv: 52.1, delta: 0.68, theta: -6.9 },
                      { id: 'p2', side: 'Venta' as const, type: 'Call' as const, strike: 5000, qty: 20, premium: 396.0, iv: 51.2, delta: 0.51, theta: -7.65 },
                      { id: 'p3', side: 'Compra' as const, type: 'Call' as const, strike: 5400, qty: 10, premium: 227.2, iv: 51.9, delta: 0.39, theta: -7.28 },
                    ],
                  },
                  {
                    label: 'Cóndor',
                    preset: [
                      { id: 'p1', side: 'Compra' as const, type: 'Put' as const, strike: 4200, qty: 10, premium: 62.0, iv: 55.2, delta: -0.15, theta: -3.2 },
                      { id: 'p2', side: 'Venta' as const, type: 'Put' as const, strike: 4600, qty: 10, premium: 148.0, iv: 53.6, delta: -0.31, theta: -5.2 },
                      { id: 'p3', side: 'Venta' as const, type: 'Call' as const, strike: 5400, qty: 10, premium: 227.2, iv: 51.9, delta: 0.39, theta: -7.28 },
                      { id: 'p4', side: 'Compra' as const, type: 'Call' as const, strike: 5800, qty: 10, premium: 135.6, iv: 53.4, delta: 0.25, theta: -5.8 },
                    ],
                  },
                  {
                    label: 'Cono vendido',
                    preset: [
                      { id: 'p1', side: 'Venta' as const, type: 'Call' as const, strike: 4800, qty: 10, premium: 485.0, iv: 51.4, delta: 0.58, theta: -7.8 },
                      { id: 'p2', side: 'Venta' as const, type: 'Put' as const, strike: 4800, qty: 10, premium: 218.9, iv: 51.8, delta: -0.42, theta: -6.1 },
                    ],
                  },
                  {
                    label: 'Cuña',
                    preset: [
                      { id: 'p1', side: 'Compra' as const, type: 'Put' as const, strike: 4600, qty: 10, premium: 148.0, iv: 53.6, delta: -0.31, theta: -5.2 },
                      { id: 'p2', side: 'Compra' as const, type: 'Call' as const, strike: 5200, qty: 10, premium: 312.5, iv: 51.6, delta: 0.45, theta: -7.42 },
                    ],
                  },
                ].map((pr) => (
                  <button
                    key={pr.label}
                    type="button"
                    onClick={() => setLegs(pr.preset)}
                    className="px-2.5 py-1 rounded-full bg-[#181C27] hover:bg-[#23293A] text-[#D1D4DC] border border-[#2A2E3D] cursor-pointer transition-colors"
                  >
                    {pr.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Tabla de composición de patas (12 columnas institucionales) */}
            <div className="overflow-x-auto rounded-[10px] border border-[#232733]">
              <table className="w-full border-collapse text-right font-mono-num text-[12px]">
                <thead>
                  <tr className="bg-[#0B0E14] border-b border-[#232733] text-[10px] font-semibold uppercase tracking-wider text-[#787B86]">
                    <th className="py-2.5 px-3 text-left">Lado</th>
                    <th className="py-2.5 px-2.5 text-left">Tipo</th>
                    <th className="py-2.5 px-2.5">Vto</th>
                    <th className="py-2.5 px-2.5">Cantidad</th>
                    <th className="py-2.5 px-2.5">Base</th>
                    <th className="py-2.5 px-2.5">Prima</th>
                    <th className="py-2.5 px-2.5">VI</th>
                    <th className="py-2.5 px-2.5">Bruto</th>
                    <th className="py-2.5 px-2.5">Neto</th>
                    <th className="py-2.5 px-2.5">Precio Mkt</th>
                    <th className="py-2.5 px-2.5">Teórico BS</th>
                    <th className="py-2.5 px-2.5">Dif. C/V</th>
                    <th className="py-2.5 px-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E222D]">
                  {legs.map((leg) => {
                    const isBuy = leg.side === 'Compra';
                    const mult = leg.type === 'Subyacente' ? 1 : 100;
                    const gross = (isBuy ? -1 : 1) * leg.premium * leg.qty * mult;
                    const fee = Math.abs(gross) * 0.0058;
                    const net = gross - fee;
                    const bsTheoretical = +(leg.premium * (1 + simIvShift * 0.012)).toFixed(2);
                    const diffBs = +(((leg.premium - bsTheoretical) / bsTheoretical) * 100).toFixed(1);

                    return (
                      <tr key={leg.id} className="h-10 hover:bg-[#171B26]">
                        <td className="px-3 text-left">
                          <select
                            value={leg.side}
                            onChange={(e) => {
                              const val = e.target.value as 'Compra' | 'Venta';
                              setLegs((prev) => prev.map((x) => (x.id === leg.id ? { ...x, side: val } : x)));
                            }}
                            className={`px-2 py-0.5 rounded font-sans font-bold text-[11.5px] bg-[#181C27] border border-[#2A2E3D] ${
                              isBuy ? 'text-[#22C55E]' : 'text-[#EF4444]'
                            }`}
                          >
                            <option value="Compra">Comprado</option>
                            <option value="Venta">Lanzado</option>
                          </select>
                        </td>
                        <td className="px-2.5 text-left">
                          <select
                            value={leg.type}
                            onChange={(e) => {
                              const val = e.target.value as 'Call' | 'Put' | 'Subyacente';
                              setLegs((prev) => prev.map((x) => (x.id === leg.id ? { ...x, type: val } : x)));
                            }}
                            className={`px-2 py-0.5 rounded font-bold text-[11px] bg-[#181C27] border border-[#2A2E3D] ${
                              leg.type === 'Call'
                                ? 'text-[#EAB308]'
                                : leg.type === 'Put'
                                ? 'text-[#C084FC]'
                                : 'text-[#38BDF8]'
                            }`}
                          >
                            <option value="Call">CALL</option>
                            <option value="Put">PUT</option>
                            <option value="Subyacente">ACCIÓN</option>
                          </select>
                        </td>
                        <td className="px-2.5 text-[#9CA3AF]">18 dic</td>
                        <td className="px-2.5">
                          <input
                            type="number"
                            min={1}
                            value={leg.qty}
                            onChange={(e) => {
                              const q = Math.max(1, Number(e.target.value));
                              setLegs((prev) => prev.map((x) => (x.id === leg.id ? { ...x, qty: q } : x)));
                            }}
                            className="w-16 px-2 py-0.5 rounded bg-[#181C27] border border-[#2A2E3D] text-right font-bold text-[#FFFFFF]"
                          />
                        </td>
                        <td className="px-2.5">
                          <select
                            value={leg.strike}
                            onChange={(e) => {
                              const k = Number(e.target.value);
                              setLegs((prev) => prev.map((x) => (x.id === leg.id ? { ...x, strike: k } : x)));
                            }}
                            className="px-2 py-0.5 rounded bg-[#181C27] border border-[#2A2E3D] font-bold text-[#FFFFFF]"
                          >
                            {[4200, 4400, 4600, 4800, 5000, 5200, 5400, 5600, 5800, 6000, 6200].map((k) => (
                              <option key={k} value={k}>
                                {fmtNum(k, 0)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2.5 font-bold text-[#FFFFFF]">$ {fmtNum(leg.premium, 2)}</td>
                        <td className="px-2.5 text-[#9CA3AF]">
                          {leg.type === 'Subyacente' ? '—' : `${fmtNum(leg.iv + simIvShift, 1)} %`}
                        </td>
                        <td className={gross >= 0 ? 'px-2.5 text-[#22C55E]' : 'px-2.5 text-[#EF4444]'}>
                          {gross >= 0 ? '+' : '-'}$ {fmtNum(Math.abs(gross), 0)}
                        </td>
                        <td className={net >= 0 ? 'px-2.5 font-bold text-[#22C55E]' : 'px-2.5 font-bold text-[#EF4444]'}>
                          {net >= 0 ? '+' : '-'}$ {fmtNum(Math.abs(net), 0)}
                        </td>
                        <td className="px-2.5 text-[#D1D4DC]">$ {fmtNum(leg.premium, 2)}</td>
                        <td className="px-2.5 text-[#9CA3AF]">$ {fmtNum(bsTheoretical, 2)}</td>
                        <td className={diffBs <= 0 ? 'px-2.5 text-[#22C55E]' : 'px-2.5 text-[#FACC15]'}>
                          {diffBs > 0 ? `+${fmtNum(diffBs, 1)}%` : `${fmtNum(diffBs, 1)}%`}
                        </td>
                        <td className="px-2 text-center">
                          <button
                            type="button"
                            onClick={() => setLegs((prev) => prev.filter((x) => x.id !== leg.id))}
                            className="text-[#787B86] hover:text-[#EF4444] cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Panel de 6 KPIs de la Posición Total al pie de la tabla */}
            {(() => {
              const pnls = builderPayoff.map((b) => b.pnl);
              const maxGainVal = Math.max(...pnls);
              const minLossVal = Math.min(...pnls);
              return (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 pt-1">
                  <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D]">
                    <div className="text-[10px] font-mono-num uppercase text-[#787B86]">CAJA AL ARMAR</div>
                    <div
                      className={`font-mono-num text-[16px] font-bold mt-0.5 ${
                        netBuilderMetrics.netCash >= 0 ? 'text-[#22C55E]' : 'text-[#EF4444]'
                      }`}
                    >
                      {netBuilderMetrics.netCash >= 0 ? '+$' : '-$'}{' '}
                      {fmtNum(Math.abs(netBuilderMetrics.netCash), 0)}
                    </div>
                    <div className="text-[10.5px] text-[#787B86]">
                      {netBuilderMetrics.netCash >= 0 ? 'Crédito neto inicial' : 'Débito neto inicial'}
                    </div>
                  </div>

                  <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D]">
                    <div className="text-[10px] font-mono-num uppercase text-[#787B86]">PÉRDIDA MÁXIMA</div>
                    <div className="font-mono-num text-[16px] font-bold text-[#EF4444] mt-0.5">
                      {minLossVal < -500000 ? 'ilimitada' : `-$ ${fmtNum(Math.abs(minLossVal), 0)}`}
                    </div>
                    <div className="text-[10.5px] text-[#787B86]">Al vencimiento (Opex)</div>
                  </div>

                  <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D]">
                    <div className="text-[10px] font-mono-num uppercase text-[#787B86]">GANANCIA MÁXIMA</div>
                    <div className="font-mono-num text-[16px] font-bold text-[#22C55E] mt-0.5">
                      +$ {fmtNum(Math.max(0, maxGainVal), 0)}
                    </div>
                    <div className="text-[10.5px] text-[#787B86]">Sobre riesgo: 137%</div>
                  </div>

                  <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D]">
                    <div className="text-[10px] font-mono-num uppercase text-[#787B86]">PROB. DE GANAR (PoP)</div>
                    <div className="font-mono-num text-[16px] font-bold text-[#FFFFFF] mt-0.5">48,4 %</div>
                    <div className="text-[10.5px] text-[#787B86]">Distribución log-normal</div>
                  </div>

                  <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D]">
                    <div className="text-[10px] font-mono-num uppercase text-[#787B86]">PRECIOS DE EMPATE</div>
                    <div className="font-mono-num text-[15px] font-bold text-[#FFFFFF] mt-0.5">
                      $ 5.168,80
                    </div>
                    <div className="text-[10.5px] font-mono-num text-[#787B86]">+5,48 % vs. spot</div>
                  </div>

                  <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D]">
                    <div className="text-[10px] font-mono-num uppercase text-[#787B86]">MOV. ESPERADO (±1σ)</div>
                    <div className="font-mono-num text-[15px] font-bold text-[#EAB308] mt-0.5">
                      ±$ 865 (±17,6%)
                    </div>
                    <div className="text-[10.5px] font-mono-num text-[#787B86]">Costo fin.: {fmtNum(simTlr, 1)}% TNA</div>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* =================================================================
              B) CURVA DE PAYOFF DINÁMICA E INTERACTIVA + HISTOGRAMA OI + 4 SLIDERS
              ================================================================= */}
          <div className="rounded-[12px] bg-[#12141A] border border-[#232733] p-5 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-[15px] font-bold text-[#FFFFFF]">
                  Curva de Payoff Interactiva (Finish vs. Teórico T+{39 - simDaysLeft}d) & Interés Abierto por Base
                </h3>
                <p className="text-[12px] text-[#9CA3AF]">
                  Mové los sliders inferiores para simular el impacto de Precio, Paso del Tiempo (Theta), Volatilidad (Vega) y Tasa (Rho).
                </p>
              </div>
              <div className="flex items-center gap-4 text-[11.5px] font-mono-num">
                <span className="inline-flex items-center gap-1.5 text-[#22C55E]">
                  <span className="w-3 h-0.5 bg-[#22C55E]" /> Finish (Opex)
                </span>
                <span className="inline-flex items-center gap-1.5 text-[#FFFFFF]">
                  <span className="w-3 h-0.5 border-b border-dashed border-white" /> Teórico ({simDaysLeft}d restantes)
                </span>
                <span className="inline-flex items-center gap-1.5 text-[#EAB308]">
                  <span className="w-2.5 h-2.5 rounded-[2px] bg-[#EAB308]" /> OI Calls
                </span>
                <span className="inline-flex items-center gap-1.5 text-[#A855F7]">
                  <span className="w-2.5 h-2.5 rounded-[2px] bg-[#A855F7]" /> OI Puts
                </span>
              </div>
            </div>

            <div className="h-72 w-full">
              <svg viewBox="0 0 680 250" className="w-full h-full overflow-visible">
                <defs>
                  <clipPath id="builder-pos-clip">
                    <rect x="55" y="15" width="595" height="85" />
                  </clipPath>
                  <clipPath id="builder-neg-clip">
                    <rect x="55" y="100" width="595" height="80" />
                  </clipPath>
                </defs>

                <line x1="55" y1="35" x2="650" y2="35" stroke="#1E222D" />
                <line x1="55" y1="100" x2="650" y2="100" stroke="#363B4C" strokeWidth="1.2" />
                <line x1="55" y1="165" x2="650" y2="165" stroke="#1E222D" />

                <text x="48" y="38" textAnchor="end" fill="#22C55E" fontSize="10" className="font-mono-num">
                  +$250k
                </text>
                <text x="48" y="103" textAnchor="end" fill="#9CA3AF" fontSize="10" className="font-mono-num">
                  $0
                </text>
                <text x="48" y="168" textAnchor="end" fill="#EF4444" fontSize="10" className="font-mono-num">
                  -$250k
                </text>

                {(() => {
                  const maxAbs = Math.max(...builderPayoff.map((p) => Math.abs(p.pnl)), 50000);
                  const pts = builderPayoff.map((p, idx) => {
                    const x = 65 + (idx / (builderPayoff.length - 1)) * 575;
                    const y = 100 - (p.pnl / maxAbs) * 62;
                    return { x, y, spot: p.spot, pnl: p.pnl };
                  });
                  const polyStr = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
                  const areaStr = `65,100 ${polyStr} 640,100`;

                  const timeDecayFactor = (39 - simDaysLeft) * 0.45 - simIvShift * 0.8;
                  const theoPts = pts
                    .map((p) => {
                      const yTheo = p.y * 0.68 + 100 * 0.32 + timeDecayFactor;
                      return `${p.x.toFixed(1)},${yTheo.toFixed(1)}`;
                    })
                    .join(' ');

                  const simSpotX = 65 + Math.min(1, Math.max(0, (simSpot - 4200) / (6200 - 4200))) * 575;

                  return (
                    <>
                      <polygon
                        points={areaStr}
                        fill="#0E382B"
                        fillOpacity="0.75"
                        clipPath="url(#builder-pos-clip)"
                      />
                      <polygon
                        points={areaStr}
                        fill="#381419"
                        fillOpacity="0.75"
                        clipPath="url(#builder-neg-clip)"
                      />
                      <polyline
                        fill="none"
                        stroke="#22C55E"
                        strokeWidth="2.4"
                        points={polyStr}
                        clipPath="url(#builder-pos-clip)"
                      />
                      <polyline
                        fill="none"
                        stroke="#EF4444"
                        strokeWidth="2.4"
                        points={polyStr}
                        clipPath="url(#builder-neg-clip)"
                      />
                      <polyline
                        fill="none"
                        stroke="#FFFFFF"
                        strokeWidth="1.8"
                        strokeDasharray="5 4"
                        points={theoPts}
                      />

                      <line
                        x1={simSpotX}
                        y1="18"
                        x2={simSpotX}
                        y2="180"
                        stroke="#EAB308"
                        strokeWidth="1.5"
                        strokeDasharray="3 3"
                      />
                      <text
                        x={simSpotX}
                        y="13"
                        textAnchor="middle"
                        fill="#EAB308"
                        fontSize="10"
                        fontWeight="bold"
                        className="font-mono-num"
                      >
                        Spot Sim: ${fmtNum(simSpot, 0)}
                      </text>

                      <line x1="55" y1="188" x2="650" y2="188" stroke="#232733" />
                      {pts.map((pt, i) => {
                        const callH = 12 + ((i * 13) % 24);
                        const putH = 8 + ((i * 9) % 20);
                        return (
                          <g key={pt.spot}>
                            <rect
                              x={pt.x - 9}
                              y={228 - callH}
                              width="8"
                              height={callH}
                              fill="#EAB308"
                              opacity="0.85"
                              rx="1.5"
                            />
                            <rect
                              x={pt.x + 1}
                              y={228 - putH}
                              width="8"
                              height={putH}
                              fill="#A855F7"
                              opacity="0.85"
                              rx="1.5"
                            />
                            <text
                              x={pt.x}
                              y="243"
                              textAnchor="middle"
                              fill="#787B86"
                              fontSize="10"
                              className="font-mono-num"
                            >
                              ${fmtNum(pt.spot, 0)}
                            </text>
                          </g>
                        );
                      })}
                    </>
                  );
                })()}
              </svg>
            </div>

            {/* 4 Sliders de simulación en vivo al pie del gráfico */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-3 border-t border-[#232733] text-[12px]">
              <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-2">
                <div className="flex justify-between">
                  <span className="text-[#9CA3AF]">Precio del Papel</span>
                  <span className="font-mono-num font-bold text-[#FFFFFF]">$ {fmtNum(simSpot, 0)}</span>
                </div>
                <input
                  type="range"
                  min={4200}
                  max={6200}
                  step={25}
                  value={simSpot}
                  onChange={(e) => setSimSpot(Number(e.target.value))}
                  className="w-full accent-[#EAB308] cursor-pointer"
                />
              </div>

              <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-2">
                <div className="flex justify-between">
                  <span className="text-[#9CA3AF]">Días que Faltan (Theta)</span>
                  <span className="font-mono-num font-bold text-[#FFFFFF]">{simDaysLeft} días</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={39}
                  value={simDaysLeft}
                  onChange={(e) => setSimDaysLeft(Number(e.target.value))}
                  className="w-full accent-[#22C55E] cursor-pointer"
                />
              </div>

              <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-2">
                <div className="flex justify-between">
                  <span className="text-[#9CA3AF]">Variación VI (Vega)</span>
                  <span className="font-mono-num font-bold text-[#38BDF8]">
                    {simIvShift >= 0 ? `+${simIvShift}` : simIvShift} pts
                  </span>
                </div>
                <input
                  type="range"
                  min={-15}
                  max={15}
                  value={simIvShift}
                  onChange={(e) => setSimIvShift(Number(e.target.value))}
                  className="w-full accent-[#38BDF8] cursor-pointer"
                />
              </div>

              <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-2">
                <div className="flex justify-between">
                  <span className="text-[#9CA3AF]">Tasa Libre de Riesgo (TLR)</span>
                  <span className="font-mono-num font-bold text-[#FFFFFF]">{fmtNum(simTlr, 1)} %</span>
                </div>
                <input
                  type="range"
                  min={15}
                  max={45}
                  step={0.5}
                  value={simTlr}
                  onChange={(e) => setSimTlr(Number(e.target.value))}
                  className="w-full accent-[#A855F7] cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* =================================================================
              C) ESCENARIOS DE ESTRÉS (-20% A +20%) Y MATRIZ DE GRIEGAS + NEUTRALIZAR DELTA
              ================================================================= */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            {/* Panel de Escenarios (-20% a +20% en escalones) */}
            <div className="lg:col-span-6 rounded-[12px] bg-[#12141A] border border-[#232733] p-5 space-y-3">
              <h3 className="text-[14.5px] font-bold text-[#FFFFFF]">
                Escenarios de Estrés del Subyacente (-20% a +20%)
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-right font-mono-num text-[12px]">
                  <thead>
                    <tr className="border-b border-[#232733] text-[10px] uppercase text-[#787B86]">
                      <th className="py-2 text-left">Paso %</th>
                      <th className="py-2">Precio Proy.</th>
                      <th className="py-2">Resultado Finish</th>
                      <th className="py-2">Teórico Hoy</th>
                      <th className="py-2 px-3 text-left">Perfil P&L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1E222D]">
                    {[-20, -16, -12, -8, -4, 0, 4, 8, 12, 16, 20].map((stepPct) => {
                      const projSpot = Math.round(displaySpot * (1 + stepPct / 100));
                      let finishPnl = 0;
                      legs.forEach((leg) => {
                        const mult = leg.side === 'Compra' ? 1 : -1;
                        const shares = leg.type === 'Subyacente' ? leg.qty : leg.qty * 100;
                        if (leg.type === 'Call') {
                          finishPnl += mult * (Math.max(0, projSpot - leg.strike) - leg.premium) * shares;
                        } else if (leg.type === 'Put') {
                          finishPnl += mult * (Math.max(0, leg.strike - projSpot) - leg.premium) * shares;
                        } else {
                          finishPnl += mult * (projSpot - leg.strike) * shares;
                        }
                      });
                      const theoNow = Math.round(finishPnl * 0.64);
                      const isPos = finishPnl >= 0;
                      const barW = Math.min(100, Math.abs(finishPnl) / 3500);

                      return (
                        <tr
                          key={stepPct}
                          className={`h-8 ${stepPct === 0 ? 'bg-[#1D2230] font-bold' : 'hover:bg-[#161A24]'}`}
                        >
                          <td
                            className={`text-left ${
                              stepPct > 0 ? 'text-[#22C55E]' : stepPct < 0 ? 'text-[#EF4444]' : 'text-[#FFFFFF]'
                            }`}
                          >
                            {stepPct > 0 ? `+${stepPct}%` : `${stepPct}%`}
                          </td>
                          <td className="text-[#FFFFFF]">$ {fmtNum(projSpot, 0)}</td>
                          <td className={isPos ? 'text-[#22C55E] font-semibold' : 'text-[#EF4444] font-semibold'}>
                            {isPos ? '+$' : '-$'} {fmtNum(Math.abs(finishPnl), 0)}
                          </td>
                          <td className={theoNow >= 0 ? 'text-[#22C55E]' : 'text-[#EF4444]'}>
                            {theoNow >= 0 ? '+$' : '-$'} {fmtNum(Math.abs(theoNow), 0)}
                          </td>
                          <td className="px-3">
                            <div className="w-24 h-2 rounded bg-[#1E222D] overflow-hidden">
                              <div
                                style={{ width: `${barW}%` }}
                                className={`h-full ${isPos ? 'bg-[#22C55E]' : 'bg-[#EF4444]'}`}
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Panel de Griegas Totales y por Componente + Neutralizar Delta */}
            <div className="lg:col-span-6 rounded-[12px] bg-[#12141A] border border-[#232733] p-5 flex flex-col justify-between gap-4">
              <div className="space-y-3">
                <h3 className="text-[14.5px] font-bold text-[#FFFFFF]">
                  Matriz de Griegas Totales y por Componente
                </h3>
                <table className="w-full border-collapse text-right font-mono-num text-[12px]">
                  <thead>
                    <tr className="border-b border-[#232733] text-[10px] uppercase text-[#787B86]">
                      <th className="py-2 text-left">Griega</th>
                      <th className="py-2 text-[#FFFFFF]">Global</th>
                      <th className="py-2 text-[#EAB308]">Call</th>
                      <th className="py-2 text-[#C084FC]">Put</th>
                      <th className="py-2 text-[#38BDF8]">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1E222D]">
                    <tr className="h-9">
                      <td className="text-left font-bold text-[#D1D4DC]">Delta (Δ acc.)</td>
                      <td className="font-bold text-[#FFFFFF]">{fmtNum(netBuilderMetrics.netDelta, 0)}</td>
                      <td className="text-[#EAB308]">+120</td>
                      <td className="text-[#C084FC]">0</td>
                      <td className="text-[#38BDF8]">0</td>
                    </tr>
                    <tr className="h-9">
                      <td className="text-left font-bold text-[#D1D4DC]">Gamma (Γ)</td>
                      <td className="font-bold text-[#FFFFFF]">+0,32</td>
                      <td className="text-[#EAB308]">+0,32</td>
                      <td className="text-[#C084FC]">0,00</td>
                      <td className="text-[#38BDF8]">0,00</td>
                    </tr>
                    <tr className="h-9">
                      <td className="text-left font-bold text-[#D1D4DC]">Vega (ν por 1% VI)</td>
                      <td className="font-bold text-[#22C55E]">+$ 3.700</td>
                      <td className="text-[#EAB308]">+$ 3.700</td>
                      <td className="text-[#C084FC]">$ 0</td>
                      <td className="text-[#38BDF8]">$ 0</td>
                    </tr>
                    <tr className="h-9">
                      <td className="text-left font-bold text-[#D1D4DC]">Theta (Θ por día)</td>
                      <td className="font-bold text-[#EF4444]">
                        {netBuilderMetrics.netTheta >= 0 ? '+$' : '-$'}{' '}
                        {fmtNum(Math.abs(netBuilderMetrics.netTheta), 0)}
                      </td>
                      <td className="text-[#EAB308]">-$ 370</td>
                      <td className="text-[#C084FC]">$ 0</td>
                      <td className="text-[#38BDF8]">$ 0</td>
                    </tr>
                    <tr className="h-9">
                      <td className="text-left font-bold text-[#D1D4DC]">Rho (ρ por 1% tasa)</td>
                      <td className="font-bold text-[#FFFFFF]">+$ 1.420</td>
                      <td className="text-[#EAB308]">+$ 1.420</td>
                      <td className="text-[#C084FC]">$ 0</td>
                      <td className="text-[#38BDF8]">$ 0</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Sección "Neutralizar el Delta" */}
              <div className="p-4 rounded-[10px] bg-[#0B0E14] border border-[#232733] space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[12.5px] font-bold text-[#FFFFFF]">
                    Neutralizar el Delta (Delta-Hedge Automático)
                  </span>
                  <span className="font-mono-num text-[11px] text-[#EAB308]">
                    Desbalance actual: {fmtNum(netBuilderMetrics.netDelta, 0)} Δ
                  </span>
                </div>
                <p className="text-[11.5px] text-[#9CA3AF]">
                  Elegí un ajuste automático para llevar la exposición direccional (Delta) de tu estrategia a cero:
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setLegs((prev) => [
                        ...prev,
                        {
                          id: `hedge-stock-${Date.now()}`,
                          side: netBuilderMetrics.netDelta >= 0 ? 'Venta' : 'Compra',
                          type: 'Subyacente',
                          strike: 4900,
                          qty: Math.max(10, Math.abs(Math.round(netBuilderMetrics.netDelta))),
                          premium: 4900,
                          iv: 0,
                          delta: 1,
                          theta: 0,
                        },
                      ])
                    }
                    className="p-2.5 rounded-[8px] bg-[#161B26] hover:bg-[#1E2536] border border-[#2A3246] text-left cursor-pointer transition-colors"
                  >
                    <div className="font-mono-num text-[12px] font-bold text-[#38BDF8]">
                      {netBuilderMetrics.netDelta >= 0 ? 'Vender' : 'Comprar'}{' '}
                      {Math.max(10, Math.abs(Math.round(netBuilderMetrics.netDelta)))} acc. {stock.ticker}
                    </div>
                    <div className="text-[10.5px] text-[#787B86]">Cobertura lineal sin alterar Gamma/Vega</div>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setLegs((prev) => [
                        ...prev,
                        {
                          id: `hedge-put-${Date.now()}`,
                          side: 'Compra',
                          type: 'Put',
                          strike: 4800,
                          qty: 3,
                          premium: 218.0,
                          iv: 52.4,
                          delta: -0.40,
                          theta: -6.1,
                        },
                      ])
                    }
                    className="p-2.5 rounded-[8px] bg-[#161B26] hover:bg-[#1E2536] border border-[#2A3246] text-left cursor-pointer transition-colors"
                  >
                    <div className="font-mono-num text-[12px] font-bold text-[#C084FC]">
                      Comprar 3 lotes PUT Base 4.800
                    </div>
                    <div className="text-[10.5px] text-[#787B86]">Neutraliza +120 Δ y suma Gamma positivo</div>
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={() =>
                  onOpenOrderTicket({
                    ticker: `COMBO-${stock.ticker}`,
                    side: netBuilderMetrics.netCash >= 0 ? 'Venta' : 'Compra',
                    price: Math.abs(netBuilderMetrics.netCash) / 1000,
                    qty: legs[0]?.qty ?? 10,
                    instrumentLabel: `Estrategia Personalizada (${legs.length} patas en ${stock.ticker})`,
                  })
                }
                className="w-full py-2.5 rounded-[10px] bg-[#EAECEF] hover:bg-white text-[#0B0E14] text-[13px] font-extrabold inline-flex items-center justify-center gap-2 cursor-pointer transition-colors"
              >
                <Send className="w-4 h-4" /> Enviar Estrategia al Ticket de Orden
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
