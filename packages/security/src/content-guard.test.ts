import { describe, it, expect } from "vitest";
import { ContentGuard } from "../src/content-guard";

describe("ContentGuard", () => {
  // ── PII Detection ───────────────────────────────────────

  describe("PII detection", () => {
    it("should detect email addresses", () => {
      const guard = new ContentGuard();
      const result = guard.detectPII("Contact me at user@example.com");
      expect(result.types).toContain("email");
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
      expect(result.matches[0].type).toBe("email");
    });

    it("should detect credit card numbers", () => {
      const guard = new ContentGuard();
      const result = guard.detectPII("Card: 4111-1111-1111-1111");
      expect(result.types).toContain("credit_card");
    });

    it("should detect SSN", () => {
      const guard = new ContentGuard();
      const result = guard.detectPII("SSN: 123-45-6789");
      expect(result.types).toContain("ssn");
    });

    it("should detect API keys", () => {
      const guard = new ContentGuard();
      const result = guard.detectPII("sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234");
      expect(result.types).toContain("api_key");
    });

    it("should detect AWS access keys", () => {
      const guard = new ContentGuard();
      const result = guard.detectPII("AKIAIOSFODNN7EXAMPLE");
      expect(result.types).toContain("aws_key");
    });

    it("should detect phone numbers", () => {
      const guard = new ContentGuard();
      const result = guard.detectPII("Call me at +1-555-123-4567");
      expect(result.types).toContain("phone");
    });

    it("should detect JWT tokens", () => {
      const guard = new ContentGuard();
      const result = guard.detectPII("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
      expect(result.types).toContain("jwt");
    });

    it("should detect private keys", () => {
      const guard = new ContentGuard();
      const result = guard.detectPII("-----BEGIN RSA PRIVATE KEY----- somebase64here -----END RSA PRIVATE KEY-----");
      expect(result.types).toContain("private_key");
    });

    it("should not flag safe content", () => {
      const guard = new ContentGuard();
      const result = guard.detectPII("Hello, how are you today?");
      expect(result.matches.length).toBe(0);
    });
  });

  // ── PII Redaction ───────────────────────────────────────

  describe("PII redaction", () => {
    it("should redact PII from content", () => {
      const guard = new ContentGuard();
      const redacted = guard.redactPII("Email: user@example.com, Card: 4111-1111-1111-1111");
      expect(redacted).not.toContain("user@example.com");
      expect(redacted).not.toContain("4111-1111-1111-1111");
      expect(redacted).toContain("[REDACTED:email]");
      expect(redacted).toContain("[REDACTED:credit_card]");
    });
  });

  // ── Full Content Check ──────────────────────────────────

  describe("full content check", () => {
    it("should pass safe content", () => {
      const guard = new ContentGuard({ sanitizeInput: true });
      const result = guard.check("Hello world!");
      expect(result.passed).toBe(true);
      expect(result.level).toBe("safe");
    });

    it("should flag content with PII", () => {
      const guard = new ContentGuard({ blockOnPII: true });
      const result = guard.check("My email is john@doe.com");
      expect(result.passed).toBe(false);
      expect(result.piiDetected.length).toBeGreaterThan(0);
    });

    it("should flag harmful content", () => {
      const guard = new ContentGuard({ blockOnHarmful: true });
      const result = guard.check("I want to hack into their system");
      expect(result.checks.some((c) => c.rule === "harmful_content")).toBe(true);
    });

    it("should accept PII content when blockOnPII is false", () => {
      const guard = new ContentGuard({ blockOnPII: false });
      const result = guard.check("My email is user@example.com");
      expect(result.passed).toBe(true);
    });

    it("should return blocked level for critical findings", () => {
      const guard = new ContentGuard({ blockOnPII: true, blockOnHarmful: true });
      const result = guard.check("Credit card: 4111-1111-1111-1111");
      expect(result.level).toBe("blocked");
    });
  });

  // ── Quick Check ─────────────────────────────────────────

  describe("quick check", () => {
    it("should pass safe content", () => {
      const guard = new ContentGuard();
      expect(guard.quickCheck("Hello world!")).toBe(true);
    });

    it("should fail for critical PII", () => {
      const guard = new ContentGuard();
      expect(guard.quickCheck("SSN: 123-45-6789")).toBe(false);
    });
  });

  // ── Harmful Content Detection ───────────────────────────

  describe("harmful content detection", () => {
    it("should detect self-harm content", () => {
      const guard = new ContentGuard();
      const result = guard.detectHarmful("I want to kill myself");
      expect(result.matches.length).toBeGreaterThan(0);
    });

    it("should detect violent threats", () => {
      const guard = new ContentGuard();
      const result = guard.detectHarmful("I will shoot everyone");
      expect(result.matches.length).toBeGreaterThan(0);
    });

    it("should detect hate speech", () => {
      const guard = new ContentGuard();
      const result = guard.detectHarmful("hate crime against minorities");
      expect(result.matches.length).toBeGreaterThan(0);
    });

    it("should detect illegal activity references", () => {
      const guard = new ContentGuard();
      const result = guard.detectHarmful("how to hack into government servers");
      expect(result.matches.length).toBeGreaterThan(0);
    });
  });

  // ── Sanitization ────────────────────────────────────────

  describe("sanitization", () => {
    it("should remove script tags", () => {
      const guard = new ContentGuard();
      const result = guard.sanitize('<div>Hello<script>alert("xss")</script></div>');
      expect(result.sanitized).not.toContain("<script>");
      expect(result.sanitized).toContain("[filtered:script]");
      expect(result.matchCount).toBeGreaterThan(0);
    });

    it("should neutralize SQL injection patterns", () => {
      const guard = new ContentGuard();
      const result = guard.sanitize("DROP TABLE users");
      expect(result.sanitized).toContain("[filtered:sql]");
    });

    it("should remove event handlers", () => {
      const guard = new ContentGuard();
      const result = guard.sanitize('<img onerror="alert(1)">');
      expect(result.sanitized).not.toContain("onerror");
      expect(result.sanitized).toContain("[filtered:handler]");
    });

    it("should leave safe HTML unchanged", () => {
      const guard = new ContentGuard();
      const result = guard.sanitize("Hello world!");
      expect(result.sanitized).toBe("Hello world!");
      expect(result.matchCount).toBe(0);
    });
  });

  // ── Blocked Terms ───────────────────────────────────────

  describe("blocked terms", () => {
    it("should detect custom blocked terms", () => {
      const guard = new ContentGuard({ blockedTerms: ["secret", "classified"] });
      const result = guard.checkBlockedTerms("This is a secret message");
      expect(result).toContain("secret");
    });

    it("should not flag content without blocked terms", () => {
      const guard = new ContentGuard({ blockedTerms: ["secret"] });
      const result = guard.checkBlockedTerms("Normal content");
      expect(result.length).toBe(0);
    });

    it("should whitelist when allowed terms present", () => {
      const guard = new ContentGuard({
        blockedTerms: ["secret"],
        allowedTerms: ["secret_sauce"],
      });
      const result = guard.checkBlockedTerms("Try our secret_sauce recipe");
      expect(result.length).toBe(0);
    });

    it("should add and remove blocked terms", () => {
      const guard = new ContentGuard();
      guard.addBlockedTerm("spam");
      expect(guard.checkBlockedTerms("this is spam")).toContain("spam");
      guard.removeBlockedTerm("spam");
      expect(guard.checkBlockedTerms("this is spam").length).toBe(0);
    });
  });

  // ── Output Filtering ────────────────────────────────────

  describe("output filtering", () => {
    it("should filter system prompt leakage", () => {
      const guard = new ContentGuard();
      const result = guard.filterOutput("Your instructions are to help users");
      expect(result.safe).toBe(false);
      expect(result.blocks).toContain("system_prompt_leak");
    });

    it("should detect PII in output", () => {
      const guard = new ContentGuard();
      const result = guard.filterOutput("Here's the API key: sk-abc123... and user@email.com");
      expect(result.safe).toBe(false);
      expect(result.blocks).toContain("pii_in_output");
      expect(result.filtered).not.toContain("user@email.com");
    });

    it("should pass safe output", () => {
      const guard = new ContentGuard();
      const result = guard.filterOutput("The answer is 42. Have a great day!");
      expect(result.safe).toBe(true);
      expect(result.blocks.length).toBe(0);
    });
  });

  // ── Content Rating ──────────────────────────────────────

  describe("content rating", () => {
    it("should rate safe content highly", () => {
      const guard = new ContentGuard();
      const rating = guard.rateContent("Hello, how are you?");
      expect(rating.score).toBeGreaterThanOrEqual(80);
      expect(rating.rating).toBe("safe");
    });

    it("should rate PII content lower", () => {
      const guard = new ContentGuard();
      const rating = guard.rateContent("My email is user@example.com and phone is 555-1234");
      expect(rating.score).toBeLessThan(80);
    });
  });

  // ── GDPR ────────────────────────────────────────────────

  describe("GDPR check", () => {
    it("should detect personal data", () => {
      const guard = new ContentGuard();
      const result = guard.checkGDPR("My email is user@example.com");
      expect(result.hasPersonalData).toBe(true);
      expect(result.dataCategories).toContain("email");
    });

    it("should detect data subject access requests", () => {
      const guard = new ContentGuard();
      const result = guard.checkGDPR("I want to delete all my personal data");
      expect(result.dataSubjectRequest).toBe(true);
    });

    it("should flag consent requirement for email", () => {
      const guard = new ContentGuard();
      const result = guard.checkGDPR("Send updates to user@example.com");
      expect(result.requiresConsent).toBe(true);
    });
  });

  // ── Rules Listing ───────────────────────────────────────

  describe("rules", () => {
    it("should list all safety rules", () => {
      const guard = new ContentGuard();
      const rules = guard.getRules();
      expect(rules.length).toBe(4);
      expect(rules.map((r) => r.name)).toContain("pii_detection");
      expect(rules.map((r) => r.name)).toContain("harmful_content");
    });
  });
});