/** Plain-language meanings for the few terms the app cannot avoid. Each says what it is for the person, not how it is built. */
export const GLOSSARY = Object.freeze({
  NQC: 'The checker that scores an AI answer for reasoning quality, made-up facts and fragility, and can stop it. It is the safety gate every plan and answer passes through.',
  WAES: 'The independent review step: separate model evaluations of an action’s truthfulness, wellbeing and safety, recorded before a customer-facing action may go ahead.',
  fingerprint: 'A short code that identifies exactly one action and the policy version it was judged under. Approving covers only that code, so if anything changes first the approval is refused.',
  'policy snapshot': 'The version of the company’s rules that were in force when a plan was judged. If the rules change afterwards, the plan has to be judged again.',
} as const)

export type GlossaryTerm = keyof typeof GLOSSARY
