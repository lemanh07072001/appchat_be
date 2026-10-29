import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

/** Declarative eligibility only; no provider names or executable expressions. */
export interface ConnectorPurchasePolicy {
  protocols: string[];
  /** Absent keeps legacy single-protocol behavior. Request mapping is independent. */
  protocolMode?: 'fixed' | 'select' | 'dual';
  isp?: { mode: 'none' | 'fixed' | 'select'; choices: {
    code: string; name: string; value: string; packageIds?: string[];
  }[] };
  country?: ConnectorPurchasePolicy['isp'];
  catalog: { field: string; equals: string | number | boolean }[];
  requiredTextInputs?: ('username' | 'password')[];
  /** Explicit opt-in. Applied only during checkout preparation, never by a worker. */
  credentialGeneration?: 'hex-pair-v1';
}

export function validatePurchasePolicy(value: unknown): asserts value is ConnectorPurchasePolicy {
  const fail = (): never => { throw new BadRequestException('Invalid connector purchase policy'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const policy = value as ConnectorPurchasePolicy;
  if (Object.keys(policy).some(key => !['protocols', 'protocolMode', 'isp', 'country', 'catalog', 'requiredTextInputs', 'credentialGeneration'].includes(key)) ||
      !Array.isArray(policy.protocols) || !policy.protocols.length || policy.protocols.length > 3 ||
      new Set(policy.protocols).size !== policy.protocols.length ||
      policy.protocols.some(protocol => !['http', 'https', 'socks5'].includes(protocol)) ||
       !Array.isArray(policy.catalog) || !policy.catalog.length || policy.catalog.length > 20) return fail();
  if (policy.protocolMode !== undefined && (!['fixed', 'select', 'dual'].includes(policy.protocolMode) ||
      policy.protocolMode === 'fixed' && policy.protocols.length !== 1 ||
      policy.protocolMode === 'select' && policy.protocols.length < 2 ||
      policy.protocolMode === 'dual' && (policy.protocols.length !== 2 ||
        !policy.protocols.includes('http') || !policy.protocols.includes('socks5')))) return fail();
  if (policy.requiredTextInputs !== undefined && (!Array.isArray(policy.requiredTextInputs) ||
      !policy.requiredTextInputs.length || policy.requiredTextInputs.length > 2 ||
      new Set(policy.requiredTextInputs).size !== policy.requiredTextInputs.length ||
      policy.requiredTextInputs.some(field => !['username', 'password'].includes(field)))) return fail();
  if (policy.credentialGeneration !== undefined && (policy.credentialGeneration !== 'hex-pair-v1' ||
      !policy.requiredTextInputs?.includes('username') || !policy.requiredTextInputs.includes('password'))) return fail();
  const seen = new Set<string>();
  if (policy.country !== undefined) {
    const { country, ...withoutCountry } = policy;
    validatePurchasePolicy({ ...withoutCountry, isp: country });
  }
  if (policy.isp !== undefined) {
    const isp = policy.isp;
    const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() &&
      value === value.trim() && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
    if (!isp || typeof isp !== 'object' || Array.isArray(isp) ||
        Object.keys(isp).some(key => !['mode', 'choices'].includes(key)) ||
        !['none', 'fixed', 'select'].includes(isp.mode) || !Array.isArray(isp.choices) || isp.choices.length > 200 ||
        (isp.mode === 'none' ? isp.choices.length !== 0 : isp.mode === 'fixed' ? isp.choices.length !== 1 : isp.choices.length < 2)) return fail();
    const codes = new Set<string>();
    for (const choice of isp.choices) {
      if (!choice || typeof choice !== 'object' || Array.isArray(choice) ||
          Object.keys(choice).some(key => !['code', 'name', 'value', 'packageIds'].includes(key)) ||
          !text(choice.code) || !text(choice.name) || !text(choice.value) || codes.has(choice.code) ||
          choice.packageIds !== undefined && (!Array.isArray(choice.packageIds) || !choice.packageIds.length ||
            choice.packageIds.length > 100 || choice.packageIds.some(id => !text(id)) ||
            new Set(choice.packageIds).size !== choice.packageIds.length)) return fail();
      codes.add(choice.code);
    }
  }
  for (const rule of policy.catalog) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) ||
        Object.keys(rule).length !== 2 || !Object.hasOwn(rule, 'equals') ||
        typeof rule.field !== 'string' || !/^[a-z][a-zA-Z0-9_]{0,63}$/.test(rule.field) ||
        ['constructor', 'prototype', '__proto__', 'credential', 'token'].includes(rule.field) || seen.has(rule.field) ||
        !['string', 'number', 'boolean'].includes(typeof rule.equals) ||
        typeof rule.equals === 'number' && !Number.isFinite(rule.equals) ||
        typeof rule.equals === 'string' && (!rule.equals.length || rule.equals.length > 256)) return fail();
    seen.add(rule.field);
  }
}

export function preparePurchaseCredentials(policy: ConnectorPurchasePolicy | undefined,
  provided: { username?: string; password?: string }): { username?: string; password?: string } {
  if (policy?.credentialGeneration === 'hex-pair-v1') {
    if (provided.username === undefined && provided.password === undefined) {
      return { username: `u${randomBytes(6).toString('hex')}`, password: `p${randomBytes(12).toString('hex')}` };
    }
    if (provided.username === undefined || provided.password === undefined) {
      throw new BadRequestException('Provide both proxy username and password, or omit both');
    }
  }
  assertPurchaseTextInputs(policy, provided);
  return { ...provided };
}

export function assertPurchaseTextInputs(policy: ConnectorPurchasePolicy | undefined, input: Record<string, unknown>) {
  for (const field of policy?.requiredTextInputs ?? []) {
    const value = input[field];
    if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) {
      // Do not echo credential values in validation errors or silently trim passwords.
      throw new BadRequestException(`Missing provider input or invalid text: ${field}`);
    }
  }
}

export function assertPurchaseProtocols(policy: ConnectorPurchasePolicy | undefined, protocols: string[]) {
  if (policy && (!protocols.length || protocols.some(protocol => !policy.protocols.includes(protocol)))) {
    throw new BadRequestException('Service protocol is not supported by connector purchase policy');
  }
  if (policy?.protocolMode === 'dual' && policy.protocols.some(protocol => !protocols.includes(protocol))) {
    throw new BadRequestException('Service protocol is not supported by connector purchase policy');
  }
}

/** Only checkout resolves defaults. Workers validate the resulting pinned selection. */
export function resolvePurchaseProtocol(policy: ConnectorPurchasePolicy | undefined, selected: unknown,
  available: string[]): string | undefined {
  assertPurchaseProtocols(policy, available);
  if (policy?.protocolMode === 'dual') {
    if (selected !== undefined) throw new BadRequestException('Dual protocol service does not accept a protocol selection');
    return undefined;
  }
  const protocol = selected ?? (policy?.protocolMode === 'select' ? undefined : available[0]);
  if (typeof protocol !== 'string' || !available.includes(protocol)) {
    throw new BadRequestException('Select a supported service protocol');
  }
  assertPurchaseProtocols(policy, [protocol]);
  return protocol;
}

export function assertPurchaseProtocolInput(policy: ConnectorPurchasePolicy | undefined, input: Record<string, unknown>) {
  if (policy?.protocolMode === 'dual') {
    if (input.protocol !== undefined) throw new BadRequestException('Dual protocol purchase policy forbids a single protocol');
  } else {
    assertPurchaseProtocols(policy, [input.protocol as string]);
  }
}

export function assertPurchasePackage(policy: ConnectorPurchasePolicy | undefined, item: Record<string, unknown>) {
  if (policy && policy.catalog.some(rule => !Object.hasOwn(item, rule.field) || item[rule.field] !== rule.equals)) {
    throw new BadRequestException('Selected package does not satisfy connector purchase policy');
  }
}

/** Resolve only from trusted service options intersected with versioned provider choices. */
export function resolvePurchaseIsp(policy: ConnectorPurchasePolicy | undefined, selected: unknown,
  available: { name: string; code: string }[], packageId: string) {
  const config = policy?.isp;
  if (!config || config.mode === 'none') {
    if (available.length || selected !== undefined && selected !== '') throw new BadRequestException('Connector does not support ISP selection');
    return undefined;
  }
  if (!Array.isArray(available) || !available.length || available.some(row => !row ||
      typeof row.code !== 'string' || typeof row.name !== 'string') ||
      new Set(available.map(row => row.code)).size !== available.length) {
    throw new BadRequestException('Service ISP options require review');
  }
  const choices = config.choices.filter(choice => !choice.packageIds || choice.packageIds.includes(packageId));
  if (available.some(row => !choices.some(choice => choice.code === row.code))) {
    throw new BadRequestException('Service ISP options are not supported by this provider package');
  }
  const code = selected === undefined || selected === '' ? (available.length === 1 ? available[0].code : undefined) : selected;
  const choice = choices.find(row => row.code === code);
  if (!choice || !available.some(row => row.code === code)) throw new BadRequestException('Select a supported service ISP');
  return { code: choice.code, name: choice.name, value: choice.value };
}

/** No worker defaults: validate exactly the API value pinned during checkout. */
export function assertPurchaseIspInput(policy: ConnectorPurchasePolicy | undefined, input: Record<string, unknown>) {
  const config = policy?.isp;
  if (!config || config.mode === 'none') {
    if (input.isp !== undefined) throw new BadRequestException('Unexpected connector ISP input');
    return;
  }
  if (!config.choices.some(choice => choice.value === input.isp &&
      (!choice.packageIds || choice.packageIds.includes(input.packageId as string)))) {
    throw new BadRequestException('Pinned ISP does not satisfy connector purchase policy');
  }
}

/** Same exact-code allowlist semantics, independent from ISP selection. */
export function resolvePurchaseCountry(policy: ConnectorPurchasePolicy | undefined, selected: unknown,
  available: { name: string; code: string }[], packageId: string) {
  try {
    return resolvePurchaseIsp(policy ? { ...policy, isp: policy.country } : undefined, selected, available, packageId);
  } catch {
    throw new BadRequestException('Select a supported service country; country configuration may require review');
  }
}

export function assertPurchaseCountryInput(policy: ConnectorPurchasePolicy | undefined, input: Record<string, unknown>) {
  try {
    assertPurchaseIspInput(policy ? { ...policy, isp: policy.country } : undefined,
      { packageId: input.packageId, ...(input.country !== undefined ? { isp: input.country } : {}) });
  } catch {
    throw new BadRequestException('Pinned country does not satisfy connector purchase policy');
  }
}
