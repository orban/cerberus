# PCC benchmark 2026-07-12T01-36-38-347Z

| fixture | policy | mode | expected | verdicts (n) | consistent | evidentiary reason | cell pass |
|---|---|---|---|---|---|---|---|
| case-01 | default | det | NOT pass/pass-with-warnings | split-required×5 | true | no | PASS |
| case-01 | default | llm | NOT pass/pass-with-warnings | split-required×5 | true | no | PASS |
| case-01 | strict | det | NOT pass/pass-with-warnings | split-required×5 | true | no | PASS |
| case-01 | strict | llm | NOT pass/pass-with-warnings | split-required×4, block×1 | false | yes | PASS |
| case-02 | default | det | pass/pass-with-warnings | pass×5 | true | no | PASS |
| case-02 | default | llm | pass/pass-with-warnings | needs-evidence×4, pass×1 | false | no | FAIL |
| case-02 | strict | det | pass/pass-with-warnings | needs-evidence×5 | true | no | FAIL |
| case-02 | strict | llm | pass/pass-with-warnings | block×5 | true | no | FAIL |
| case-03 | default | det | needs-evidence/block | pass×5 | true | no | FAIL |
| case-03 | default | llm | needs-evidence/block | needs-evidence×5 | true | no | PASS |
| case-03 | strict | det | needs-evidence/block | needs-evidence×5 | true | no | PASS |
| case-03 | strict | llm | needs-evidence/block | block×5 | true | no | PASS |
| case-04 | default | det | pass/pass-with-warnings | pass×5 | true | no | PASS |
| case-04 | default | llm | pass/pass-with-warnings | pass×1, needs-evidence×2, pass-with-warnings×2 | false | no | FAIL |
| case-04 | strict | det | pass/pass-with-warnings | needs-evidence×5 | true | no | FAIL |
| case-04 | strict | llm | pass/pass-with-warnings | block×5 | true | no | FAIL |

Raw, unedited product output: results/2026-07-12T01-36-38-347Z/raw/
