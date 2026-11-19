# Owner review: 20 extraction labels

Labels are agent-labelled. Please check each against its policy (link) and mark ✅ or write the correct value.
Field rules: LABELING.md.

## h1:faraday_inc (test) — [policy](https://hackerone.com/faraday_inc/policy)
- [ ] **scanning**: `"unclear"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"none"`
- [ ] **test_accounts**: `"stated"`
- [ ] **excluded_classes**: `["dos", "rate limiting", "csv injection", "permissive cors", "open redirect", "tabnabbing", "missing security headers", "ssl/tls best practices", "spf/dkim/dmarc", "mitm", "version disclosure", "outdated browsers", "self-xss", "intended product behavior", "public tokens"]`
- [ ] **safe_harbour**: `"yes"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"stated"`

## h1:wellsfargo-bbp (test) — [policy](https://hackerone.com/wellsfargo-bbp/policy)
- [ ] **scanning**: `"limited"`
- [ ] **rate_limit**: `"500/s"`
- [ ] **required_header**: `"x-bug-bounty"`
- [ ] **test_accounts**: `"stated"`
- [ ] **excluded_classes**: `["http header best practices", "spf/dkim/dmarc", "version disclosure", "verbose errors", "self-xss", "web app hygiene", "clickjacking", "csrf", "mitm", "vulnerable libraries", "csv injection", "ssl/tls best practices", "dos", "content spoofing", "stealer logs"]`
- [ ] **safe_harbour**: `"yes"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"stated"`

## h1:csg-public (test) — [policy](https://hackerone.com/csg-public/policy)
- [ ] **scanning**: `"unclear"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"none"`
- [ ] **test_accounts**: `"stated"`
- [ ] **excluded_classes**: `["subdomain takeover", "clickjacking", "verbose errors", "404 pages", "banner disclosure", "public files", "scripting/automation", "autocomplete", "missing cookie flags", "content spoofing", "tabnabbing", "spf/dkim/dmarc", "captcha bypass", "logout csrf", "brute force"]`
- [ ] **safe_harbour**: `"unclear"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"stated"`

## h1:alshaya (test) — [policy](https://hackerone.com/alshaya/policy)
- [ ] **scanning**: `"limited"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"none"`
- [ ] **test_accounts**: `"none"`
- [ ] **excluded_classes**: `["clickjacking", "logout/login csrf", "insecure cookie settings", "version disclosure", "mitm", "vulnerable libraries", "csv injection", "ssl/tls issues", "hsts", "dos", "content spoofing", "subdomain takeover without poc", "spf/dkim/dmarc", "outdated browsers", "missing security headers"]`
- [ ] **safe_harbour**: `"yes"`
- [ ] **bounty_table**: `"vdp"`
- [ ] **disclosure**: `"stated"`

## bugcrowd:sophos (test) — [policy](https://bugcrowd.com/engagements/sophos)
- [ ] **scanning**: `"unclear"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"none"`
- [ ] **test_accounts**: `"stated"`
- [ ] **excluded_classes**: `["dos on sophos central", "security feature bypass", "false negatives", "leaked credentials without acquisition steps", "scanner output as whole report"]`
- [ ] **safe_harbour**: `"yes"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"stated"`

## bugcrowd:atlassian (test) — [policy](https://bugcrowd.com/engagements/atlassian)
- [ ] **scanning**: `"no"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"none"`
- [ ] **test_accounts**: `"stated"`
- [ ] **excluded_classes**: `["descriptive error messages", "banner disclosure", "clickjacking", "logout csrf", "content spoofing", "autocomplete", "non-sensitive cookie flags", "weak captcha", "brute force", "user enumeration", "missing security headers", "cache poisoning", "ssl/tls issues", "self-xss", "dos"]`
- [ ] **safe_harbour**: `"yes"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"stated"`

## bugcrowd:etsy (test) — [policy](https://bugcrowd.com/engagements/etsy)
- [ ] **scanning**: `"limited"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"none"`
- [ ] **test_accounts**: `"stated"`
- [ ] **excluded_classes**: `["out of date browsers", "non-xss content injection", "logout csrf", "non-sensitive cookie flags", "username enumeration", "csrf with nonce", "dos", "spam", "third party systems", "no rate limiting on login form", "no password policy"]`
- [ ] **safe_harbour**: `"no"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"unclear"`

## bugcrowd:consensus-mbb-og (dev) — [policy](https://bugcrowd.com/engagements/consensus-mbb-og)
- [ ] **scanning**: `"unclear"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"none"`
- [ ] **test_accounts**: `"stated"`
- [ ] **excluded_classes**: `["idor", "dos", "url redirection", "coin scams", "xss", "social engineering", "payment processing", "third party"]`
- [ ] **safe_harbour**: `"yes"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"unclear"`

## intigriti:afaeab02-261f-486e-8a43-4dee76fccabb (test) — [policy](https://app.intigriti.com/programs/rivian/rivianbugbounty/detail)
- [ ] **scanning**: `"unclear"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"x-intigriti-username"`
- [ ] **test_accounts**: `"stated"`
- [ ] **excluded_classes**: `["captcha bypass", "subdomain takeover", "cache poisoning dos", "graphql alias overloading", "third-party infrastructure", "self-xss", "missing security headers", "missing cookie flags", "csrf with low impact", "clickjacking without impact", "rate limiting", "spf/dmarc", "username enumeration", "email bombing", "version disclosure"]`
- [ ] **safe_harbour**: `"yes"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"stated"`

## intigriti:0bcc2455-bd63-490b-b725-890a93a1c678 (dev) — [policy](https://app.intigriti.com/programs/lansweeper/fing/detail)
- [ ] **scanning**: `"unclear"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"none"`
- [ ] **test_accounts**: `"stated"`
- [ ] **excluded_classes**: `["self-xss", "missing security headers", "missing cookie flags", "csrf with low impact", "clickjacking without impact", "rate limiting", "spf/dmarc", "username enumeration", "email bombing", "version disclosure", "dos", "brute force", "social engineering", "reverse tabnabbing", "password policy"]`
- [ ] **safe_harbour**: `"yes"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"stated"`

## intigriti:9a3f850e-4387-4434-98c7-dba2827b727b (dev) — [policy](https://app.intigriti.com/programs/revolut/revolutvdp/detail)
- [ ] **scanning**: `"unclear"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"none"`
- [ ] **test_accounts**: `"stated"`
- [ ] **excluded_classes**: `["csv injection", "homograph attacks", "xml-rpc", "verbose errors", "social engineering", "dos", "spf/dmarc", "self-xss", "missing security headers", "missing cookie flags", "csrf with low impact", "clickjacking without impact", "reverse tabnabbing", "password policy", "version disclosure"]`
- [ ] **safe_harbour**: `"yes"`
- [ ] **bounty_table**: `"vdp"`
- [ ] **disclosure**: `"stated"`

## intigriti:611efbaa-333e-4b7c-a3c0-89665abd3fe3 (test) — [policy](https://app.intigriti.com/programs/altera/altera/detail)
- [ ] **scanning**: `"unclear"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"none"`
- [ ] **test_accounts**: `"none"`
- [ ] **excluded_classes**: `["third-party products", "licensed products", "pre-release products", "end of life products", "open-source software", "web infrastructure", "credentials leaks", "duplicates", "physical access attacks", "dll hijacking"]`
- [ ] **safe_harbour**: `"yes"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"stated"`

## ywh:yes-we-hack (test) — [policy](https://yeswehack.com/programs/yes-we-hack)
- [ ] **scanning**: `"limited"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"none"`
- [ ] **test_accounts**: `"none"`
- [ ] **excluded_classes**: `["self-xss", "tabnabbing", "missing cookie flags", "content injection", "mixed content", "clickjacking", "dos", "known cves without poc", "social engineering", "autocomplete", "outdated libraries", "tls/ssl best practices", "missing security headers", "csrf on logout", "spf/dkim/dmarc"]`
- [ ] **safe_harbour**: `"unclear"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"stated"`

## ywh:vincisa-public-program (test) — [policy](https://yeswehack.com/programs/vincisa-public-program)
- [ ] **scanning**: `"limited"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"user-agent"`
- [ ] **test_accounts**: `"stated"`
- [ ] **excluded_classes**: `["tabnabbing", "missing cookie flags", "content injection", "mixed content", "clickjacking", "dos", "outdated libraries", "self-xss", "tls/ssl best practices", "missing security headers", "csrf on logout", "spf/dkim/dmarc", "session expiration", "rate limiting", "user enumeration"]`
- [ ] **safe_harbour**: `"unclear"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"stated"`

## ywh:vidaxl-services-open-bug-bounty-program (test) — [policy](https://yeswehack.com/programs/vidaxl-services-open-bug-bounty-program)
- [ ] **scanning**: `"limited"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"user-agent"`
- [ ] **test_accounts**: `"stated"`
- [ ] **excluded_classes**: `["tabnabbing", "missing cookie flags", "content injection", "clickjacking", "dos", "social engineering", "autocomplete", "self-xss", "ssl/tls issues", "missing security headers", "csrf on logout", "spf/dkim/dmarc", "session management issues", "rate limiting", "user enumeration"]`
- [ ] **safe_harbour**: `"unclear"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"stated"`

## ywh:atg-public-bug-bounty-program (test) — [policy](https://yeswehack.com/programs/atg-public-bug-bounty-program)
- [ ] **scanning**: `"limited"`
- [ ] **rate_limit**: `"10/s"`
- [ ] **required_header**: `"none"`
- [ ] **test_accounts**: `"stated"`
- [ ] **excluded_classes**: `["tabnabbing", "missing cookie flags", "content injection", "clickjacking", "dos", "social engineering", "autocomplete", "self-xss", "ssl/tls issues", "missing security headers", "csrf on logout", "spf/dkim/dmarc", "session management issues", "rate limiting", "user enumeration"]`
- [ ] **safe_harbour**: `"yes"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"stated"`

## immunefi:berachain (dev) — [policy](https://immunefi.com/bug-bounty/berachain/information/)
- [ ] **scanning**: `"limited"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"none"`
- [ ] **test_accounts**: `"none"`
- [ ] **excluded_classes**: `["social engineering", "best practices", "feature requests", "leaked keys", "privileged address access", "stablecoin depegging", "test files", "secrets in github", "oracle data", "51% attacks", "lack of liquidity", "sybil attacks", "centralization risks", "theoretical user interactions"]`
- [ ] **safe_harbour**: `"unclear"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"stated"`

## immunefi:ondofinance (dev) — [policy](https://immunefi.com/bug-bounty/ondofinance/information/)
- [ ] **scanning**: `"limited"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"none"`
- [ ] **test_accounts**: `"none"`
- [ ] **excluded_classes**: `["social engineering", "best practices", "feature requests", "leaked keys", "privileged address access", "stablecoin depegging", "test files", "secrets in github", "oracle data", "51% attacks", "lack of liquidity", "sybil attacks", "centralization risks"]`
- [ ] **safe_harbour**: `"unclear"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"stated"`

## immunefi:fluxfinance (test) — [policy](https://immunefi.com/bug-bounty/fluxfinance/information/)
- [ ] **scanning**: `"limited"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"none"`
- [ ] **test_accounts**: `"none"`
- [ ] **excluded_classes**: `["social engineering", "best practices", "feature requests", "leaked keys", "privileged address access", "stablecoin depegging", "test files", "secrets in github", "oracle data", "51% attacks", "lack of liquidity", "sybil attacks", "centralization risks"]`
- [ ] **safe_harbour**: `"unclear"`
- [ ] **bounty_table**: `"stated"`
- [ ] **disclosure**: `"stated"`

## immunefi:charm (test) — [policy](https://immunefi.com/bug-bounty/charm/information/)
- [ ] **scanning**: `"limited"`
- [ ] **rate_limit**: `"none"`
- [ ] **required_header**: `"none"`
- [ ] **test_accounts**: `"none"`
- [ ] **excluded_classes**: `["social engineering", "best practices", "feature requests", "leaked keys", "privileged address access", "stablecoin depegging", "test files", "secrets in github", "oracle data", "51% attacks", "lack of liquidity", "sybil attacks", "centralization risks"]`
- [ ] **safe_harbour**: `"unclear"`
- [ ] **bounty_table**: `"unclear"`
- [ ] **disclosure**: `"stated"`
