# PCC benchmark 2026-07-12T01-32-19-428Z

| fixture | policy | mode | expected | verdicts (n) | consistent | evidentiary reason | cell pass |
|---|---|---|---|---|---|---|---|
| case-01 | default | det | NOT pass/pass-with-warnings | split-required×1 | true | no | PASS |
| case-01 | strict | det | NOT pass/pass-with-warnings | split-required×1 | true | no | PASS |
| case-02 | default | det | pass/pass-with-warnings | pass×1 | true | no | PASS |
| case-02 | strict | det | pass/pass-with-warnings | needs-evidence×1 | true | no | FAIL |
| case-03 | default | det | needs-evidence/block | pass×1 | true | no | FAIL |
| case-03 | strict | det | needs-evidence/block | needs-evidence×1 | true | no | PASS |
| case-04 | default | det | pass/pass-with-warnings | pass×1 | true | no | PASS |
| case-04 | strict | det | pass/pass-with-warnings | needs-evidence×1 | true | no | FAIL |

Raw, unedited product output: results/2026-07-12T01-32-19-428Z/raw/
