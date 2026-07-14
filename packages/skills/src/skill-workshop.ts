import * as crypto from "crypto";

export interface SkillProposalFile {
  path: string;
  content: string;
  hash: string;
  type: "skill" | "config" | "asset" | "script";
}

export interface SkillProposal {
  id: string;
  name: string;
  description: string;
  author: string;
  status: "draft" | "submitted" | "under_review" | "approved" | "rejected" | "quarantined";
  version: number;
  createdAt: number;
  updatedAt: number;
  reviewedBy?: string;
  reviewComment?: string;
  files: SkillProposalFile[];
  frontmatter: {
    version: number;
    date: string;
    author: string;
    reviewedAt?: string;
  };
}

export interface SkillWorkshopConfig {
  enabled: boolean;
  requireReview: boolean;
  autoApproveTrustedAuthors: string[];
  maxProposalsPerAuthor: number;
  quarantineOnRejection: boolean;
}

const DEFAULT_CONFIG: SkillWorkshopConfig = {
  enabled: true,
  requireReview: true,
  autoApproveTrustedAuthors: [],
  maxProposalsPerAuthor: 10,
  quarantineOnRejection: true,
};

interface InstalledSkillRecord {
  proposalId: string;
  installedAt: number;
}

export class SkillWorkshop {
  private proposals = new Map<string, SkillProposal>();
  private installedSkills = new Map<string, InstalledSkillRecord>();
  private config: SkillWorkshopConfig;

  constructor(config?: Partial<SkillWorkshopConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  createProposal(
    name: string,
    description: string,
    author: string,
    files: Omit<SkillProposalFile, "hash">[]
  ): SkillProposal {
    if (!this.config.enabled) {
      throw new Error("Skill Workshop is disabled");
    }

    const authorProposals = this.listProposals().filter((p) => p.author === author);
    if (authorProposals.length >= this.config.maxProposalsPerAuthor) {
      throw new Error(
        `Author "${author}" has reached the maximum of ${this.config.maxProposalsPerAuthor} proposals`
      );
    }

    const now = Date.now();
    const proposal: SkillProposal = {
      id: crypto.randomUUID(),
      name,
      description,
      author,
      status: "draft",
      version: 1,
      createdAt: now,
      updatedAt: now,
      files: files.map((f) => ({
        ...f,
        hash: this.computeHash(f.content),
      })),
      frontmatter: {
        version: 1,
        date: new Date(now).toISOString(),
        author,
      },
    };

    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  submitProposal(proposalId: string): SkillProposal | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return null;

    if (proposal.status !== "draft") {
      return null;
    }

    proposal.status = "submitted";
    proposal.updatedAt = Date.now();

    // Auto-approve if author is trusted and review is not required
    if (
      this.config.autoApproveTrustedAuthors.includes(proposal.author) &&
      !this.config.requireReview
    ) {
      proposal.status = "approved";
      proposal.reviewedBy = "system";
      proposal.reviewComment = "Auto-approved: trusted author";
      proposal.frontmatter.reviewedAt = new Date().toISOString();
    }

    return proposal;
  }

  reviewProposal(
    proposalId: string,
    reviewer: string,
    decision: "approve" | "reject",
    comment?: string
  ): SkillProposal | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return null;

    if (proposal.status !== "submitted" && proposal.status !== "under_review") {
      return null;
    }

    if (decision === "approve") {
      proposal.status = "approved";
    } else {
      proposal.status = this.config.quarantineOnRejection ? "quarantined" : "rejected";
    }

    proposal.reviewedBy = reviewer;
    proposal.reviewComment = comment;
    proposal.updatedAt = Date.now();
    proposal.frontmatter.reviewedAt = new Date().toISOString();

    return proposal;
  }

  reviseProposal(
    proposalId: string,
    files: Omit<SkillProposalFile, "hash">[],
    comment?: string
  ): SkillProposal | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return null;

    if (proposal.status !== "rejected" && proposal.status !== "submitted") {
      return null;
    }

    proposal.version += 1;
    proposal.files = files.map((f) => ({
      ...f,
      hash: this.computeHash(f.content),
    }));
    proposal.frontmatter.version = proposal.version;
    proposal.frontmatter.date = new Date().toISOString();
    proposal.reviewComment = comment;
    proposal.updatedAt = Date.now();

    // Reset review state on revision
    if (proposal.status === "rejected") {
      proposal.status = "draft";
      proposal.reviewedBy = undefined;
      proposal.frontmatter.reviewedAt = undefined;
    }

    return proposal;
  }

  getProposal(proposalId: string): SkillProposal | undefined {
    return this.proposals.get(proposalId);
  }

  listProposals(status?: SkillProposal["status"]): SkillProposal[] {
    const all = Array.from(this.proposals.values());
    if (status) {
      return all.filter((p) => p.status === status);
    }
    return all;
  }

  getTodayActions(): {
    pendingReview: SkillProposal[];
    recentlyApproved: SkillProposal[];
    recentlyRejected: SkillProposal[];
  } {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    const all = Array.from(this.proposals.values());

    return {
      pendingReview: all.filter(
        (p) => p.status === "submitted" || p.status === "under_review"
      ),
      recentlyApproved: all.filter(
        (p) => p.status === "approved" && now - p.updatedAt < oneDayMs
      ),
      recentlyRejected: all.filter(
        (p) =>
          (p.status === "rejected" || p.status === "quarantined") &&
          now - p.updatedAt < oneDayMs
      ),
    };
  }

  async installApproved(proposalId: string): Promise<boolean> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return false;

    if (proposal.status !== "approved") {
      return false;
    }

    // Verify file hashes before installation
    for (const file of proposal.files) {
      const currentHash = this.computeHash(file.content);
      if (currentHash !== file.hash) {
        process.stderr.write(
          `[SkillWorkshop] Hash mismatch for file "${file.path}" in proposal "${proposalId}". ` +
          `Expected: ${file.hash}, Got: ${currentHash}\n`
        );
        return false;
      }
    }

    // Record installation metadata.
    // 已知限制：本安装仅记录内存元数据，不写文件到磁盘，故无 previousFiles 需要回滚；
    // rollback() 也只回退状态，不还原文件内容。若未来引入真实文件写入，需在此捕获
    // 旧文件内容并在 rollback 中还原。
    this.installedSkills.set(proposal.name, {
      proposalId,
      installedAt: Date.now(),
    });

    proposal.status = "approved"; // remains approved after install
    proposal.updatedAt = Date.now();

    return true;
  }

  rollback(proposalId: string): boolean {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return false;

    const installed = this.installedSkills.get(proposal.name);
    if (!installed || installed.proposalId !== proposalId) {
      return false;
    }

    // Restore previous version state
    this.installedSkills.delete(proposal.name);
    proposal.status = "approved"; // back to approved (not installed)
    proposal.updatedAt = Date.now();

    return true;
  }

  getStats(): { total: number; byStatus: Record<string, number>; avgReviewTime: number } {
    const all = Array.from(this.proposals.values());
    const byStatus: Record<string, number> = {};

    for (const proposal of all) {
      byStatus[proposal.status] = (byStatus[proposal.status] || 0) + 1;
    }

    // Calculate average review time for proposals that have been reviewed
    const reviewed = all.filter(
      (p) => p.frontmatter.reviewedAt && p.reviewedBy
    );
    let avgReviewTime = 0;
    if (reviewed.length > 0) {
      const totalReviewTime = reviewed.reduce((sum, p) => {
        const reviewedAt = new Date(p.frontmatter.reviewedAt!).getTime();
        return sum + (reviewedAt - p.createdAt);
      }, 0);
      avgReviewTime = totalReviewTime / reviewed.length;
    }

    return {
      total: all.length,
      byStatus,
      avgReviewTime,
    };
  }

  private computeHash(content: string): string {
    // 安全：改用 sha256 替代 DJB2，避免哈希碰撞导致完整性校验失效
    return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
  }
}
