# PCC benchmark 2026-07-12T02-16-24-656Z — matched-pair rows (case-05, case-06)

| fixture | policy | mode | expected | verdicts (n) | consistent | evidentiary reason | cell pass |
|---|---|---|---|---|---|---|---|
| case-01 | default | det | NOT pass/pass-with-warnings | split-required×5 | true | no | FAIL |
| case-05 | default | det | pass/pass-with-warnings | pass×5 | true | no | PASS |
| case-05 | default | llm | pass/pass-with-warnings | pass×4, needs-evidence×1 | false | no | FAIL |
| case-05 | strict | det | pass/pass-with-warnings | needs-evidence×5 | true | no | FAIL |
| case-05 | strict | llm | pass/pass-with-warnings | pass×3, block×1, pass-with-warnings×1 | false | no | FAIL |
| case-06 | default | det | needs-evidence/block | pass×5 | true | no | FAIL |
| case-06 | default | llm | needs-evidence/block | pass×3, needs-evidence×2 | false | no | FAIL |
| case-06 | strict | det | needs-evidence/block | needs-evidence×5 | true | no | PASS |
| case-06 | strict | llm | needs-evidence/block | pass-with-warnings×1, block×2, pass×2 | false | no | FAIL |

Raw, unedited product output: raw/
