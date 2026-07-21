# Private Adoption Lab — Result Screen Refinement

This iteration refines the saved assessment result screen without changing the public beta.

## Implemented

- Decision-first order: Assessment, Your Decision, Communication, recommendation reasons, Monitoring History, Assessment Details, Project Details, supporting feedback/outcome, Project Actions, and back navigation.
- Monitoring History is collapsed by default, shows the total monitoring-point count, and lists the latest point first when expanded.
- Every monitoring point now displays one factual defining reason based on signal, workable-window, reason, or meaningful score changes. Unchanged refreshes display `No material change.`
- `My Final Call` is renamed `Your Decision`.
- Recommendation and contractor decision are visually separated.
- `Local context FieldCall cannot see` is renamed `Local Conditions` with clearer helper text.
- Decision save text changes with the selected decision and confirms the saved decision.
- Communication and recommendation-reason cards use white backgrounds with restrained gold accents.
- Category scores are displayed as a compact Production / Quality / Safety breakdown.
- The score circle now leads with the numeric score, followed by the risk level.
- Assessment Details, Project Details, and Monitoring History are collapsed by default.
- Project Actions are reduced in visual weight; Delete is quieter than Copy to new date.
- Bottom navigation is labeled `← Dashboard`.
- Vertical spacing and communication button height are reduced.

## Deliberately deferred

Recommendation confidence is not displayed yet because no validated confidence value is currently supplied by the scoring system.
