/**
 * exports.test.ts — the REACHABILITY / exported-symbol acceptance gate
 * (SDD §8.4 proof 1 — accident-prevention coverage; the B9 reframe makes the
 * runtime gate the enforced boundary, but this asserts the export SURFACE).
 *
 *   - the barrel exports the four PURE functions + the ports + the data/schema
 *     types + the error ADT (the §4.6 table).
 *   - the barrel exports NO raw live-writer constructor (no LiveRoleWriter,
 *     makeRoleWriter, createLiveRoleWriter, etc.) — the only RoleWriter path is
 *     the S1 GateCheckedRoleWriter (NOT in the S0 surface either).
 *   - the barrel exports NO `WriteCapability` CONSTRUCTOR (the branded type is a
 *     type-only export; no runtime value `WriteCapability`, mintWriteCapability,
 *     makeWriteCapability, etc.).
 *
 * Pure surface assertion — no Layers, no mocks.
 */
import { describe, expect, test } from 'bun:test';
import * as substrate from '../index.js';

const runtimeKeys = Object.keys(substrate);

describe('exported-symbol table (§4.6) — required symbols present', () => {
  test('the four PURE functions are exported', () => {
    expect(typeof substrate.roleMapVersionHash).toBe('function');
    expect(typeof substrate.computeProposed).toBe('function');
    expect(typeof substrate.diff).toBe('function');
    expect(typeof substrate.transition).toBe('function');
  });

  test('the three ports are exported as Context.Tags', () => {
    expect(substrate.RosterSource).toBeDefined();
    expect(substrate.RoleWriter).toBeDefined();
    expect(substrate.ScoreSource).toBeDefined();
  });

  test('the error ADT constructors are exported', () => {
    expect(typeof substrate.GuardFailed).toBe('function');
    expect(typeof substrate.ShadowGateRejected).toBe('function');
    expect(typeof substrate.WriteError).toBe('function');
    expect(typeof substrate.AuthzError).toBe('function');
    expect(typeof substrate.AuditError).toBe('function');
    expect(typeof substrate.RosterError).toBe('function');
    expect(typeof substrate.ScoreError).toBe('function');
  });

  test('the render-model + config-surface schemas are exported', () => {
    expect(substrate.Discrepancy).toBeDefined();
    expect(substrate.ProposedRoster).toBeDefined();
    expect(substrate.CurrentRoster).toBeDefined();
    expect(substrate.RoleMapConfig).toBeDefined();
    expect(substrate.ApplyModeConfig).toBeDefined();
    expect(substrate.OnboardingLifecycle).toBeDefined();
  });
});

describe('REACHABILITY — deliberate absences (§8.4 proof 1)', () => {
  test('NO raw live-writer constructor is exported', () => {
    const forbiddenLiveWriter = runtimeKeys.filter((k) =>
      /^(make|create|build|new)?.*(Live)?RoleWriter$/i.test(k) &&
      k !== 'RoleWriter' && // the port Tag is allowed
      /live|make|create|build|new/i.test(k),
    );
    expect(forbiddenLiveWriter).toEqual([]);
  });

  test('the only RoleWriter-named export is the port Tag (no concrete writer)', () => {
    const roleWriterish = runtimeKeys.filter((k) => /rolewriter/i.test(k));
    expect(roleWriterish).toEqual(['RoleWriter']);
    // and GateCheckedRoleWriter (the S1 gate) is NOT in the S0 surface
    expect(runtimeKeys).not.toContain('GateCheckedRoleWriter');
  });

  test('NO WriteCapability CONSTRUCTOR / runtime value is exported', () => {
    // `WriteCapability` is a TYPE-only export — there must be no runtime binding
    // by that name, and no mint/make/create constructor for it.
    expect(substrate).not.toHaveProperty('WriteCapability');
    const capabilityCtors = runtimeKeys.filter((k) =>
      /(mint|make|create|build|new|issue).*writecapability|writecapability.*(constructor|ctor)/i.test(k),
    );
    expect(capabilityCtors).toEqual([]);
    // belt-and-suspenders: no runtime key contains "writecapability" at all
    expect(runtimeKeys.filter((k) => /writecapability/i.test(k))).toEqual([]);
  });

  test('NO discord.js / HTTP / DB symbol leaked through the barrel', () => {
    const ioish = runtimeKeys.filter((k) => /discord|guild|http|fetch|pg|postgres|redis|nats/i.test(k));
    expect(ioish).toEqual([]);
  });
});
