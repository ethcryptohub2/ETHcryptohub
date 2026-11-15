import { z } from 'zod';

const decimal = z.string().regex(/^\d+(?:\.\d+)?$/);
const side = z.enum(['BUY', 'SELL']);
const clientAlgoId = z.string().regex(/^[A-Za-z0-9_-]{1,36}$/);

const closeAllParametersSchema = z.object({
  algoType: z.literal('CONDITIONAL'),
  symbol: z.string().regex(/^[A-Z0-9]{2,30}$/),
  side,
  type: z.enum(['STOP_MARKET', 'TAKE_PROFIT_MARKET']),
  triggerPrice: decimal,
  closePosition: z.literal('true'),
  workingType: z.literal('MARK_PRICE'),
  positionSide: z.literal('BOTH'),
  clientAlgoId,
}).strict();

const trailingParametersSchema = z.object({
  algoType: z.literal('CONDITIONAL'),
  symbol: z.string().regex(/^[A-Z0-9]{2,30}$/),
  side,
  type: z.literal('TRAILING_STOP_MARKET'),
  activatePrice: decimal,
  callbackRate: z.literal('1'),
  quantity: decimal,
  reduceOnly: z.literal('true'),
  workingType: z.literal('MARK_PRICE'),
  positionSide: z.literal('BOTH'),
  clientAlgoId,
}).strict();

const responseSchema = z.object({
  algoId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  clientAlgoId,
  algoStatus: z.string(),
  algoType: z.literal('CONDITIONAL'),
  symbol: z.string(),
  side,
  positionSide: z.literal('BOTH'),
  orderType: z.enum(['STOP_MARKET', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP_MARKET']),
  triggerPrice: z.union([z.number(), decimal]).optional(),
  activatePrice: z.union([z.number(), decimal]).optional(),
  callbackRate: z.union([z.number(), decimal]).optional(),
  quantity: z.union([z.number(), decimal]).optional(),
  reduceOnly: z.union([z.boolean(), z.string()]).optional(),
  closePosition: z.union([z.boolean(), z.string()]).optional(),
  workingType: z.string().optional(),
}).passthrough();

function canonicalDecimal(value: string | number) {
  const raw = String(value).toLowerCase();
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(raw);
  if (!match) return null;
  const whole = match[1]!;
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent)) return null;
  const digits = whole + fraction;
  const point = whole.length + exponent;
  const integer = point <= 0
    ? '0'
    : point >= digits.length
      ? digits + '0'.repeat(point - digits.length)
      : digits.slice(0, point);
  const decimal = point <= 0
    ? '0'.repeat(-point) + digits
    : point >= digits.length
      ? ''
      : digits.slice(point);
  const normalizedInteger = integer.replace(/^0+(?=\d)/, '');
  const normalizedFraction = decimal.replace(/0+$/, '');
  return normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger;
}

function sameDecimal(left: string | number, right: string | number) {
  const leftCanonical = canonicalDecimal(left);
  return leftCanonical !== null && leftCanonical === canonicalDecimal(right);
}

export type BinanceAlgoAdapter = {
  request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    parameters?: Record<string, string>,
  ): Promise<T>;
};

export type BinanceCloseAllAlgoParameters = z.infer<typeof closeAllParametersSchema>;
export type BinanceTrailingAlgoParameters = z.infer<typeof trailingParametersSchema>;
export type BinanceAlgoParameters = BinanceCloseAllAlgoParameters | BinanceTrailingAlgoParameters;
export type BinanceAlgoOrder = z.infer<typeof responseSchema>;

export class BinanceAlgoOrderError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = 'BinanceAlgoOrderError';
  }
}

export function buildCloseAllAlgoOrderParameters(input: {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  triggerPrice: string;
  clientAlgoId: string;
}): BinanceCloseAllAlgoParameters {
  return closeAllParametersSchema.parse({
    algoType: 'CONDITIONAL',
    ...input,
    closePosition: 'true',
    workingType: 'MARK_PRICE',
    positionSide: 'BOTH',
  });
}

export function validateBinanceAlgoParameters(parameters: Record<string, string>) {
  const parsed = parameters.type === 'TRAILING_STOP_MARKET'
    ? trailingParametersSchema.safeParse(parameters)
    : closeAllParametersSchema.safeParse(parameters);
  if (!parsed.success) {
    throw new BinanceAlgoOrderError(
      parameters.type === 'TRAILING_STOP_MARKET'
        ? 'Invalid Binance TRAILING_STOP_MARKET Algo order parameters.'
        : 'Invalid Binance close-all Algo order parameters; closePosition cannot be combined with quantity or reduceOnly.',
      422,
    );
  }
  return parsed.data;
}

export function verifyBinanceAlgoOrder(
  order: unknown,
  expected: BinanceAlgoParameters,
): string | null {
  const parsed = responseSchema.safeParse(order);
  if (!parsed.success) return null;
  const actual = parsed.data;
  if (
    actual.algoStatus !== 'NEW' ||
    actual.clientAlgoId !== expected.clientAlgoId ||
    actual.algoType !== expected.algoType ||
    actual.symbol !== expected.symbol ||
    actual.side !== expected.side ||
    actual.positionSide !== expected.positionSide ||
    actual.orderType !== expected.type
  ) return null;

  if ('triggerPrice' in expected) {
    if (
      actual.triggerPrice === undefined ||
      !sameDecimal(actual.triggerPrice, expected.triggerPrice) ||
      actual.workingType !== expected.workingType ||
      String(actual.closePosition).toLowerCase() !== 'true' ||
      (actual.reduceOnly !== undefined && String(actual.reduceOnly).toLowerCase() === 'true') ||
      (actual.quantity !== undefined && !sameDecimal(actual.quantity, '0'))
    ) return null;
  } else if (
    actual.activatePrice === undefined ||
    !sameDecimal(actual.activatePrice, expected.activatePrice) ||
    actual.callbackRate === undefined ||
    !sameDecimal(actual.callbackRate, expected.callbackRate) ||
    actual.quantity === undefined ||
    !sameDecimal(actual.quantity, expected.quantity) ||
    String(actual.reduceOnly).toLowerCase() !== 'true' ||
    (actual.closePosition !== undefined && String(actual.closePosition).toLowerCase() === 'true') ||
    actual.workingType !== expected.workingType
  ) return null;

  return String(actual.algoId);
}

export function findUniqueOpenBinanceAlgoOrder(
  orders: BinanceAlgoOrder[],
  algoId: string | null,
  clientId: string | null,
): BinanceAlgoOrder | undefined {
  const matches = orders.filter((order) =>
    order.algoStatus === 'NEW' &&
    ((algoId !== null && String(order.algoId) === algoId) ||
      (clientId !== null && order.clientAlgoId === clientId)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export async function listOpenBinanceAlgoOrders(
  adapter: BinanceAlgoAdapter,
  symbol: string,
): Promise<BinanceAlgoOrder[]> {
  const raw: unknown = await adapter.request('GET', '/fapi/v1/openAlgoOrders', { symbol });
  const parsed = z.array(responseSchema).safeParse(raw);
  if (!parsed.success) {
    throw new BinanceAlgoOrderError('Binance returned invalid open Algo orders; protection was not reconciled.', 502);
  }
  return parsed.data;
}

export async function queryBinanceAlgoOrder(
  adapter: BinanceAlgoAdapter,
  symbol: string,
  identifier: { algoId: string } | { clientAlgoId: string },
): Promise<unknown> {
  if ('algoId' in identifier && !/^\d+$/.test(identifier.algoId)) {
    throw new BinanceAlgoOrderError('Invalid Binance Algo order ID.', 422);
  }
  if ('clientAlgoId' in identifier && !clientAlgoId.safeParse(identifier.clientAlgoId).success) {
    throw new BinanceAlgoOrderError('Invalid Binance client Algo order ID.', 422);
  }
  return adapter.request('GET', '/fapi/v1/algoOrder', { symbol, ...identifier });
}

export async function cancelBinanceAlgoOrder(
  adapter: BinanceAlgoAdapter,
  symbol: string,
  algoId: string,
): Promise<void> {
  if (!/^\d+$/.test(algoId)) throw new BinanceAlgoOrderError('Invalid Binance Algo order ID.', 422);
  await adapter.request('DELETE', '/fapi/v1/algoOrder', { symbol, algoId });
}

export async function submitAndVerifyBinanceAlgoOrder(
  adapter: BinanceAlgoAdapter,
  parameters: BinanceAlgoParameters,
): Promise<string> {
  const validated = validateBinanceAlgoParameters(parameters);
  let algoId: string | undefined;
  let submitError: unknown;
  try {
    const requestParameters: Record<string, string> = {};
    for (const [key, value] of Object.entries(validated)) {
      if (typeof value !== 'string') throw new BinanceAlgoOrderError('Binance Algo order parameters must be strings.', 422);
      requestParameters[key] = value;
    }
    const response: unknown = await adapter.request(
      'POST',
      '/fapi/v1/algoOrder',
      requestParameters,
    );
    if (typeof response === 'object' && response !== null && 'algoId' in response) {
      const parsed = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).safeParse(response.algoId);
      if (parsed.success) algoId = String(parsed.data);
    }
  } catch (error) {
    submitError = error;
  }

  let reconciled: unknown;
  try {
    reconciled = await queryBinanceAlgoOrder(
      adapter,
      validated.symbol,
      algoId ? { algoId } : { clientAlgoId: validated.clientAlgoId },
    );
  } catch (queryError) {
    if (submitError === undefined) throw queryError;
    const queryCode = typeof queryError === 'object' && queryError !== null && 'exchangeCode' in queryError
      ? queryError.exchangeCode
      : undefined;
    const submitMessage = submitError instanceof Error ? submitError.message : 'Unknown submission error.';
    if (queryCode === -2013) throw submitError;
    const queryMessage = queryError instanceof Error ? queryError.message : 'Unknown query error.';
    throw new BinanceAlgoOrderError(
      `Algo order outcome is unknown. Submission failed (${submitMessage}); query failed (${queryMessage}). Do not submit a duplicate.`,
    );
  }
  const verifiedAlgoId = verifyBinanceAlgoOrder(reconciled, validated);
  if (!verifiedAlgoId || (algoId !== undefined && verifiedAlgoId !== algoId)) {
    throw new BinanceAlgoOrderError(
      `Binance Algo order ${validated.clientAlgoId} was not verified as active with the requested protection.`,
      502,
    );
  }
  return verifiedAlgoId;
}
