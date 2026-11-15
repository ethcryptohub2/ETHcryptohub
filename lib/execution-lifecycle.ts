export type ExecutionDirection = 'LONG' | 'SHORT';
export type ExecutionEnvironment = 'DEMO' | 'LIVE';
export type ExecutionStrategy = 'STANDARD' | 'HIGH_RISK_SCALPING';

export type ExecutionScope =
  | {
      kind: 'CUSTOMER';
      userId: number;
      strategy: ExecutionStrategy;
      environment: ExecutionEnvironment;
      executionId: string;
    }
  | {
      kind: 'ADMIN_DEMO_TEST';
      adminUserId: number;
      testAccountId: string;
      sessionId: string;
      strategy: 'STANDARD';
      environment: 'DEMO';
      executionId: string;
      authorizationId: string;
    };

export type ProtectionIdentifiers = {
  stopAlgoId: string;
  tp3AlgoId: string;
  trailingAlgoId: string;
};

export type LifecycleExecution = {
  symbol: string;
  direction: ExecutionDirection;
  quantity: string;
  stopPrice: string;
  tp2Price: string;
  tp3Price: string;
  tp1Price: string;
  tickSize: string;
  closeClientOrderId?: string;
};

export type EntryOrderStatus =
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN';

export type EntryOrderResult = {
  orderId: string;
  status: EntryOrderStatus;
  executedQuantity: string;
};

export type EntryRequest = {
  clientOrderId: string;
  execution: LifecycleExecution;
  entryPrice?: string;
};

export type EntryLifecycleResult =
  | { status: 'PROTECTED'; orderId: string; quantity: string; protection: ProtectionIdentifiers }
  | { status: 'UNCERTAIN'; reason: string }
  | { status: 'FAILED'; reason: string }
  | { status: 'BUSY' };

export interface ExecutionAuthorizationPolicy {
  assertAuthorized(scope: ExecutionScope): Promise<void>;
}

export interface ExecutionEnvironmentPolicy {
  assertEnvironment(scope: ExecutionScope): Promise<void>;
}

export interface ExchangeExecutionPort {
  assertEntryPreconditions?(scope: ExecutionScope, execution: LifecycleExecution): Promise<void>;
  submitEntry?(scope: ExecutionScope, request: EntryRequest): Promise<EntryOrderResult>;
  lookupEntry?(scope: ExecutionScope, symbol: string, clientOrderId: string): Promise<EntryOrderResult | null>;
  cancelEntry?(scope: ExecutionScope, symbol: string, orderId: string): Promise<EntryOrderResult>;
  installProtection(
    scope: ExecutionScope,
    execution: LifecycleExecution,
  ): Promise<ProtectionIdentifiers>;
  verifyProtection(
    scope: ExecutionScope,
    execution: LifecycleExecution,
    identifiers: ProtectionIdentifiers,
  ): Promise<boolean>;
  getPosition(scope: ExecutionScope, symbol: string): Promise<{ amount: string }>;
  closePositionAndVerify(scope: ExecutionScope, execution: LifecycleExecution): Promise<{
    closed: boolean;
    reason?: string;
  }>;
  cancelObsoleteProtection(
    scope: ExecutionScope,
    execution: LifecycleExecution,
    identifiers: ProtectionIdentifiers,
  ): Promise<void>;
}

export interface ExecutionRepository {
  assertScope(scope: ExecutionScope): Promise<void>;
  markProtected(scope: ExecutionScope, identifiers: ProtectionIdentifiers): Promise<void>;
  markClosed(scope: ExecutionScope): Promise<void>;
  markUncertain(scope: ExecutionScope, reason: string): Promise<void>;
}

export interface EntryExecutionRepository {
  reserveEntry(scope: ExecutionScope, request: EntryRequest): Promise<'CREATED' | 'EXISTING' | 'BUSY'>;
  markEntryUncertain(scope: ExecutionScope, reason: string): Promise<void>;
  markEntryFailed(scope: ExecutionScope, reason: string): Promise<void>;
  markEntryFilled(scope: ExecutionScope, order: EntryOrderResult, quantity: string): Promise<void>;
}

export interface ProtectionRepository {
  loadProtectionIdentifiers(scope: ExecutionScope): Promise<ProtectionIdentifiers | null>;
  markProtectionVerified(
    scope: ExecutionScope,
    identifiers: ProtectionIdentifiers,
    progress: { tp1Reached: boolean; tp2Reached: boolean; trailingActivated: boolean },
  ): Promise<void>;
  markProtectionFailed(scope: ExecutionScope, reason: string): Promise<void>;
}

export interface ReconciliationRepository {
  claim(scope: ExecutionScope): Promise<boolean>;
  release(scope: ExecutionScope): Promise<void>;
}

export interface LifecycleEventPublisher {
  publish(event: {
    type:
      | 'ENTRY_SUBMITTED'
      | 'ENTRY_UNCERTAIN'
      | 'PROTECTION_VERIFIED'
      | 'EXECUTION_CLOSED'
      | 'RECONCILIATION_UNCERTAIN';
    scope: ExecutionScope;
  }): Promise<void>;
}

export type ExecutionLifecycleDependencies = {
  authorization: ExecutionAuthorizationPolicy;
  environment: ExecutionEnvironmentPolicy;
  exchange: ExchangeExecutionPort;
  executions: ExecutionRepository;
  entries?: EntryExecutionRepository;
  protections: ProtectionRepository;
  reconciliation: ReconciliationRepository;
  events: LifecycleEventPublisher;
};

function isValidScope(scope: ExecutionScope) {
  const principalId = 'userId' in scope ? scope.userId : scope.adminUserId;
  if (!Number.isSafeInteger(principalId) ||
      typeof scope.executionId !== 'string' || !/^\d+$/.test(scope.executionId)) return false;
  if (scope.kind === 'CUSTOMER') return scope.strategy === 'STANDARD' || scope.strategy === 'HIGH_RISK_SCALPING';
  return scope.kind === 'ADMIN_DEMO_TEST' &&
    scope.environment === 'DEMO' &&
    scope.strategy === 'STANDARD' &&
    scope.testAccountId.length > 0 &&
    /^\d+$/.test(scope.sessionId) &&
    scope.authorizationId.length > 0;
}

function amountMatches(amount: string, direction: ExecutionDirection, quantity: string) {
  if (!/^-?\d+(?:\.\d+)?$/.test(amount) || !/^\d+(?:\.\d+)?$/.test(quantity)) return false;
  const actual = Number(amount);
  const expected = Number(quantity);
  return Number.isFinite(actual) && Number.isFinite(expected) && expected > 0 &&
    Math.sign(actual) === (direction === 'LONG' ? 1 : -1) &&
    Math.abs(actual) === expected;
}

export function createExecutionLifecycle(dependencies: ExecutionLifecycleDependencies) {
  async function authorizePolicies(scope: ExecutionScope) {
    if (!isValidScope(scope)) throw new Error('Execution scope is invalid.');
    await dependencies.authorization.assertAuthorized(scope);
    await dependencies.environment.assertEnvironment(scope);
  }

  async function authorize(scope: ExecutionScope) {
    await authorizePolicies(scope);
    await dependencies.executions.assertScope(scope);
  }

  async function protectOpenedPosition(
    scope: ExecutionScope,
    execution: LifecycleExecution,
  ): Promise<ProtectionIdentifiers> {
    await authorize(scope);
    const identifiers = await dependencies.exchange.installProtection(scope, execution);
    const [active, position] = await Promise.all([
      dependencies.exchange.verifyProtection(scope, execution, identifiers),
      dependencies.exchange.getPosition(scope, execution.symbol),
    ]);
    if (!active || !amountMatches(position.amount, execution.direction, execution.quantity)) {
      throw new Error('Exchange protection and full position quantity were not independently verified.');
    }
    await dependencies.protections.markProtectionVerified(scope, identifiers, {
      tp1Reached: false,
      tp2Reached: false,
      trailingActivated: false,
    });
    await dependencies.executions.markProtected(scope, identifiers);
    await dependencies.events.publish({ type: 'PROTECTION_VERIFIED', scope });
    return identifiers;
  }

  async function submitAndProtectEntry(
    scope: ExecutionScope,
    request: EntryRequest,
  ): Promise<EntryLifecycleResult> {
    const entries = dependencies.entries;
    const exchange = dependencies.exchange;
    if (!entries || !exchange.assertEntryPreconditions || !exchange.submitEntry ||
        !exchange.lookupEntry || !exchange.cancelEntry) {
      throw new Error('Entry execution ports are not configured.');
    }
    if (
      !/^[A-Za-z0-9_-]{1,36}$/.test(request.clientOrderId) ||
      !/^[A-Z0-9]{2,30}$/.test(request.execution.symbol) ||
      !['LONG', 'SHORT'].includes(request.execution.direction) ||
      !/^\d+(?:\.\d+)?$/.test(request.execution.quantity) ||
      !Number.isFinite(Number(request.execution.quantity)) ||
      Number(request.execution.quantity) <= 0 ||
      (request.entryPrice !== undefined &&
        (!/^\d+(?:\.\d+)?$/.test(request.entryPrice) ||
          !Number.isFinite(Number(request.entryPrice)) ||
          Number(request.entryPrice) <= 0)) ||
      ![request.execution.stopPrice, request.execution.tp1Price, request.execution.tp2Price,
        request.execution.tp3Price, request.execution.tickSize].every((price) =>
        /^\d+(?:\.\d+)?$/.test(price) && Number.isFinite(Number(price)) && Number(price) > 0) ||
      (request.execution.direction === 'LONG'
        ? !(Number(request.execution.stopPrice) < Number(request.execution.tp1Price) &&
          Number(request.execution.tp1Price) < Number(request.execution.tp2Price) &&
          Number(request.execution.tp2Price) < Number(request.execution.tp3Price))
        : !(Number(request.execution.tp3Price) < Number(request.execution.tp2Price) &&
          Number(request.execution.tp2Price) < Number(request.execution.tp1Price) &&
          Number(request.execution.tp1Price) < Number(request.execution.stopPrice)))
    ) {
      throw new Error('Entry request failed local symbol, direction, quantity, or protective-price validation.');
    }

    await authorizePolicies(scope);
    const reservation = await entries.reserveEntry(scope, request);
    if (reservation === 'BUSY') return { status: 'BUSY' };

    let order: EntryOrderResult | null = null;
    if (reservation === 'CREATED') {
      try {
        await exchange.assertEntryPreconditions(scope, request.execution);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Entry preflight failed.';
        await entries.markEntryFailed(scope, reason);
        return { status: 'FAILED', reason };
      }
      try {
        order = await exchange.submitEntry(scope, request);
        await dependencies.events.publish({ type: 'ENTRY_SUBMITTED', scope });
      } catch {
        try {
          order = await exchange.lookupEntry(scope, request.execution.symbol, request.clientOrderId);
        } catch {
          order = null;
        }
        if (!order) {
          const reason = 'Entry submission outcome is unknown. No duplicate entry was submitted.';
          await entries.markEntryUncertain(scope, reason);
          await dependencies.events.publish({ type: 'ENTRY_UNCERTAIN', scope });
          return { status: 'UNCERTAIN', reason };
        }
      }
    } else {
      try {
        order = await exchange.lookupEntry(scope, request.execution.symbol, request.clientOrderId);
      } catch {
        order = null;
      }
      if (!order) {
        const reason = 'Entry order was not found during recovery. No duplicate entry was submitted.';
        await entries.markEntryUncertain(scope, reason);
        await dependencies.events.publish({ type: 'ENTRY_UNCERTAIN', scope });
        return { status: 'UNCERTAIN', reason };
      }
    }

    if (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED') {
      try {
        order = await exchange.cancelEntry(scope, request.execution.symbol, order.orderId);
      } catch {
        const reason = 'Entry cancellation outcome is unknown. Reconcile the original client order ID before retrying.';
        await entries.markEntryUncertain(scope, reason);
        await dependencies.events.publish({ type: 'ENTRY_UNCERTAIN', scope });
        return { status: 'UNCERTAIN', reason };
      }
      if (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED') {
        const reason = 'Entry remains open after cancellation. No additional entry was submitted.';
        await entries.markEntryUncertain(scope, reason);
        await dependencies.events.publish({ type: 'ENTRY_UNCERTAIN', scope });
        return { status: 'UNCERTAIN', reason };
      }
    }

    const filledQuantity = Number(order.executedQuantity);
    if (
      !/^\d+(?:\.\d+)?$/.test(order.executedQuantity) ||
      !Number.isFinite(filledQuantity) ||
      !order.orderId ||
      order.status === 'UNKNOWN' ||
      !['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(order.status) ||
      filledQuantity > Number(request.execution.quantity)
    ) {
      const reason = 'Entry order state or filled quantity is invalid or uncertain. Reconciliation is required before any retry.';
      await entries.markEntryUncertain(scope, reason);
      await dependencies.events.publish({ type: 'ENTRY_UNCERTAIN', scope });
      return { status: 'UNCERTAIN', reason };
    }

    if (filledQuantity === 0 || !['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(order.status)) {
      const reason = 'Entry order has no confirmed fill quantity or has an unrecognized final state.';
      await entries.markEntryFailed(scope, reason);
      return { status: 'FAILED', reason };
    }

    const actualExecution = { ...request.execution, quantity: order.executedQuantity };
    let position: { amount: string };
    try {
      position = await exchange.getPosition(scope, actualExecution.symbol);
    } catch {
      const reason = 'Entry fill is recorded but position state is unavailable. Reconciliation is required.';
      await entries.markEntryUncertain(scope, reason);
      await dependencies.events.publish({ type: 'ENTRY_UNCERTAIN', scope });
      return { status: 'UNCERTAIN', reason };
    }
    if (!amountMatches(position.amount, actualExecution.direction, order.executedQuantity)) {
      const reason = 'Exchange position side or quantity differs from the confirmed entry fill. Do not retry or reverse.';
      await entries.markEntryUncertain(scope, reason);
      await dependencies.events.publish({ type: 'ENTRY_UNCERTAIN', scope });
      return { status: 'UNCERTAIN', reason };
    }

    await entries.markEntryFilled(scope, order, order.executedQuantity);
    try {
      const protection = await protectOpenedPosition(scope, actualExecution);
      return {
        status: 'PROTECTED',
        orderId: order.orderId,
        quantity: order.executedQuantity,
        protection,
      };
    } catch (error) {
      const reason = error instanceof Error
        ? `Entry fill was confirmed but protection could not be verified: ${error.message}`
        : 'Entry fill was confirmed but protection could not be verified.';
      await entries.markEntryUncertain(scope, reason);
      await dependencies.events.publish({ type: 'ENTRY_UNCERTAIN', scope });
      return { status: 'UNCERTAIN', reason };
    }
  }

  async function reconcile(
    scope: ExecutionScope,
    execution: LifecycleExecution,
    targets: { tp1Reached: boolean; tp2Reached: boolean; tp3Reached: boolean; trailingActivated: boolean },
  ): Promise<'CLOSED' | 'PROTECTED' | 'UNCERTAIN' | 'BUSY'> {
    await authorize(scope);
    if (!(await dependencies.reconciliation.claim(scope))) return 'BUSY';
    try {
      const identifiers = await dependencies.protections.loadProtectionIdentifiers(scope);
      if (!identifiers) {
        await dependencies.executions.markUncertain(scope, 'Protection identifiers are missing.');
        await dependencies.protections.markProtectionFailed(scope, 'Protection identifiers are missing.');
        await dependencies.events.publish({ type: 'RECONCILIATION_UNCERTAIN', scope });
        return 'UNCERTAIN';
      }

      const [position, active] = await Promise.all([
        dependencies.exchange.getPosition(scope, execution.symbol),
        dependencies.exchange.verifyProtection(scope, execution, identifiers),
      ]);
      if (!/^-?\d+(?:\.\d+)?$/.test(position.amount)) {
        throw new Error('Exchange position quantity is invalid.');
      }
      const amount = Number(position.amount);
      if (!Number.isFinite(amount)) throw new Error('Exchange position quantity is invalid.');

      if (amount === 0) {
        await dependencies.exchange.cancelObsoleteProtection(scope, execution, identifiers);
        await dependencies.executions.markClosed(scope);
        await dependencies.events.publish({ type: 'EXECUTION_CLOSED', scope });
        return 'CLOSED';
      }

      if (!amountMatches(position.amount, execution.direction, execution.quantity)) {
        await dependencies.executions.markUncertain(scope, 'Position direction or quantity differs from the execution record; protection was retained.');
        await dependencies.protections.markProtectionFailed(scope, 'Position direction or quantity differs from the execution record.');
        await dependencies.events.publish({ type: 'RECONCILIATION_UNCERTAIN', scope });
        return 'UNCERTAIN';
      }

      if (targets.tp3Reached || !active) {
        const close = await dependencies.exchange.closePositionAndVerify(scope, execution);
        if (!close.closed) {
          const reason = close.reason ?? 'Position closure was not confirmed; existing protection was retained.';
          await dependencies.executions.markUncertain(scope, reason);
          await dependencies.protections.markProtectionFailed(scope, reason);
          await dependencies.events.publish({ type: 'RECONCILIATION_UNCERTAIN', scope });
          return 'UNCERTAIN';
        }
        const zeroPosition = await dependencies.exchange.getPosition(scope, execution.symbol);
        if (zeroPosition.amount !== '0' && Number(zeroPosition.amount) !== 0) {
          const reason = 'A zero position was not confirmed after the close; existing protection was retained.';
          await dependencies.executions.markUncertain(scope, reason);
          await dependencies.protections.markProtectionFailed(scope, reason);
          await dependencies.events.publish({ type: 'RECONCILIATION_UNCERTAIN', scope });
          return 'UNCERTAIN';
        }
        await dependencies.exchange.cancelObsoleteProtection(scope, execution, identifiers);
        await dependencies.executions.markClosed(scope);
        await dependencies.events.publish({ type: 'EXECUTION_CLOSED', scope });
        return 'CLOSED';
      }

      await dependencies.protections.markProtectionVerified(scope, identifiers, {
        tp1Reached: targets.tp1Reached,
        tp2Reached: targets.tp2Reached,
        trailingActivated: targets.trailingActivated,
      });
      await dependencies.executions.markProtected(scope, identifiers);
      await dependencies.events.publish({ type: 'PROTECTION_VERIFIED', scope });
      return 'PROTECTED';
    } finally {
      await dependencies.reconciliation.release(scope);
    }
  }

  return { submitAndProtectEntry, protectOpenedPosition, reconcile };
}

export function createCustomerExecutionLifecycle(
  dependencies: ExecutionLifecycleDependencies,
  policy: {
    assertCustomerAuthorization(scope: Extract<ExecutionScope, { kind: 'CUSTOMER' }>): Promise<void>;
    assertCustomerReconciliation?(scope: Extract<ExecutionScope, { kind: 'CUSTOMER' }>): Promise<void>;
  },
) {
  const lifecycle = createExecutionLifecycle(dependencies);
  return {
    submitAndProtectEntry(
      scope: Extract<ExecutionScope, { kind: 'CUSTOMER' }>,
      request: EntryRequest,
    ) {
      return policy.assertCustomerAuthorization(scope).then(() => lifecycle.submitAndProtectEntry(scope, request));
    },
    protectOpenedPosition(
      scope: Extract<ExecutionScope, { kind: 'CUSTOMER' }>,
      execution: LifecycleExecution,
    ) {
      return policy.assertCustomerAuthorization(scope).then(() => lifecycle.protectOpenedPosition(scope, execution));
    },
    reconcile(
      scope: Extract<ExecutionScope, { kind: 'CUSTOMER' }>,
      execution: LifecycleExecution,
      targets: { tp1Reached: boolean; tp2Reached: boolean; tp3Reached: boolean; trailingActivated: boolean },
    ) {
      const authorizeReconciliation = policy.assertCustomerReconciliation ?? policy.assertCustomerAuthorization;
      return authorizeReconciliation(scope).then(() => lifecycle.reconcile(scope, execution, targets));
    },
  };
}

export function createAdminDemoExecutionLifecycle(
  dependencies: ExecutionLifecycleDependencies,
  policy: {
    assertAdminRole(scope: Extract<ExecutionScope, { kind: 'ADMIN_DEMO_TEST' }>): Promise<void>;
    assertTemporaryAuthorization(scope: Extract<ExecutionScope, { kind: 'ADMIN_DEMO_TEST' }>): Promise<void>;
    assertIsolatedDemoAccount(scope: Extract<ExecutionScope, { kind: 'ADMIN_DEMO_TEST' }>): Promise<void>;
  },
) {
  const lifecycle = createExecutionLifecycle(dependencies);
  async function authorizeAdmin(scope: Extract<ExecutionScope, { kind: 'ADMIN_DEMO_TEST' }>) {
    await policy.assertAdminRole(scope);
    await policy.assertTemporaryAuthorization(scope);
    await policy.assertIsolatedDemoAccount(scope);
    await lifecyclePolicyEnvironment(dependencies, scope);
  }
  return {
    submitAndProtectEntry(
      scope: Extract<ExecutionScope, { kind: 'ADMIN_DEMO_TEST' }>,
      request: EntryRequest,
    ) {
      return authorizeAdmin(scope).then(() => lifecycle.submitAndProtectEntry(scope, request));
    },
    protectOpenedPosition(
      scope: Extract<ExecutionScope, { kind: 'ADMIN_DEMO_TEST' }>,
      execution: LifecycleExecution,
    ) {
      return authorizeAdmin(scope).then(() => lifecycle.protectOpenedPosition(scope, execution));
    },
    reconcile(
      scope: Extract<ExecutionScope, { kind: 'ADMIN_DEMO_TEST' }>,
      execution: LifecycleExecution,
      targets: { tp1Reached: boolean; tp2Reached: boolean; tp3Reached: boolean; trailingActivated: boolean },
    ) {
      return authorizeAdmin(scope).then(() => lifecycle.reconcile(scope, execution, targets));
    },
  };
}

async function lifecyclePolicyEnvironment(
  dependencies: ExecutionLifecycleDependencies,
  scope: ExecutionScope,
) {
  await dependencies.authorization.assertAuthorized(scope);
  await dependencies.environment.assertEnvironment(scope);
}
