# Bake-off rubric

Score each of the twelve outputs (six briefs, two models) from `scripts/out/<model>/<n>.json` on the six criteria below, 0 to 2 each, for a maximum of 12 per output.

- **2:** the criterion is fully met, as described.
- **1:** partly met.
- **0:** not met.

| # | Criterion | 2 points when |
| --- | --- | --- |
| 1 | Arithmetic consistency | Route nights and day count match the brief, with no warnings |
| 2 | Specific to place and season | Stops, areas and the season note could not be pasted into another trip |
| 3 | Budget completeness | Flights, every stop's stay, food, transport, activities, eSIM and insurance are present with plausible ranges |
| 4 | No live claims | Nothing reads as a quoted, current or verified price |
| 5 | Honest take | Blunt, and consistent with the computed verdict |
| 6 | Interview quality | Every question is destination-specific and would change the plan |

**Pass rule.** Haiku passes if it averages at least 9 of 12 and never scores 0 on criterion 1 or criterion 4.

## Scores

Copy this table into `scripts/bakeoff-results.md` and fill it in.

| Brief | Model | 1 Arithmetic | 2 Specific | 3 Budget | 4 No live claims | 5 Honest take | 6 Interview | Total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 Vietnam | claude-haiku-5-5 | | | | | | | |
| 2 Japan | claude-haiku-5-5 | | | | | | | |
| 3 Tasmania | claude-haiku-5-5 | | | | | | | |
| 4 NZ South Island | claude-haiku-5-5 | | | | | | | |
| 5 Bali | claude-haiku-5-5 | | | | | | | |
| 6 Rome, Florence, Paris | claude-haiku-5-5 | | | | | | | |
| 1 Vietnam | claude-sonnet-5-5 | | | | | | | |
| 2 Japan | claude-sonnet-5-5 | | | | | | | |
| 3 Tasmania | claude-sonnet-5-5 | | | | | | | |
| 4 NZ South Island | claude-sonnet-5-5 | | | | | | | |
| 5 Bali | claude-sonnet-5-5 | | | | | | | |
| 6 Rome, Florence, Paris | claude-sonnet-5-5 | | | | | | | |
