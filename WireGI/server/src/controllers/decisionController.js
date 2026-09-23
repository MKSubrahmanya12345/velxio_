export function createDecisionController({ jev, registry }) {
  return {
    decide: ({ state, questions }) => jev.decide({ state: state || {}, questions }, { registry }),
  };
}
