# Security Policy

## Supported Versions
The following versions of this project are currently supported with security updates:

| Version | Supported |
|---------|-----------|
| main    | ✔️ Active |
| others  | ❌ Not supported |

If you are using a fork or an older branch, please update to the latest version before reporting issues.

---

## Reporting a Vulnerability

If you believe you have found a security vulnerability, please follow these steps:

1. **Do not open a public issue.**
2. Email the maintainer privately at:  
   **security@yourdomain.com**  
   (Replace with your actual contact email.)
3. Include:
   - A clear description of the issue  
   - Steps to reproduce  
   - Any relevant logs, PoC, or screenshots  
   - The potential impact

You will receive a response within **48 hours**.

---

## Disclosure Policy

- We will confirm the vulnerability and provide an estimated timeline for a fix.
- We aim to release a patch within **7 days** for critical issues and **14–30 days** for others.
- You will be credited in the release notes unless you prefer to remain anonymous.

---

## Security Best Practices for Contributors

- Do not commit secrets, tokens, or credentials.
- Use environment variables or GitHub Actions secrets.
- Run `npm audit`, `dotnet list package --vulnerable`, or equivalent before submitting PRs.
- Avoid adding dependencies without justification.

---

## CodeQL / Automated Scanning

This repository uses (or intends to use) automated security scanning tools such as:

- **GitHub CodeQL** (if enabled)
- **Dependabot**
- **Secret scanning** (if available)

These tools help detect vulnerabilities early, but manual review is still required.

---

## Contact

For any non‑security questions, please use GitHub Issues or Discussions.
