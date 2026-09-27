/**
 * The what-if engine (M7 part 3). Every result is an estimate, never a
 * decision: nothing here authorizes, spends or changes state. Deterministic
 * given a seed.
 */
export { mulberry32, normal, quantile, median, type Rng } from './random.ts'
export {
  describeShock,
  ledgerPeriods,
  MIN_HISTORY_PERIODS,
  simulateCash,
  validateShocks,
  type AssumedDistribution,
  type CashShock,
  type CashSimulation,
  type CashSimulationResult,
  type CashStep,
  type PeriodFlow,
  type SimulateCashOptions,
} from './cash.ts'
export {
  simulateExperiment,
  type ExperimentOutcome,
  type ExperimentSimulation,
  type ExperimentSimulationResult,
  type SimulateExperimentOptions,
} from './experiment.ts'
export { generateScenarios, SCENARIO_KINDS, type Scenario, type ScenarioBase, type ScenarioKind, type ScenarioSet } from './scenarios.ts'
export {
  COUNTERFACTUAL_GRID,
  counterfactualAutonomy,
  counterfactualKernel,
  type AutonomyCounterfactual,
  type CounterfactualRow,
  type DepartmentCounterfactual,
  type KernelAgreement,
  type KernelCall,
  type KernelCounterfactual,
} from './counterfactual.ts'
