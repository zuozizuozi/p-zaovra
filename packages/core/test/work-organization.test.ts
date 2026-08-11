import { describe, expect, test } from "bun:test"
import { Config } from "@zaovra-ai/core/config"
import { ConfigWork } from "@zaovra-ai/core/config/work"
import { WorkOrganization } from "@zaovra-ai/core/work/organization"
import { Work } from "@zaovra-ai/schema/work"

describe("WorkOrganization", () => {
  test("merges configured Role Contracts by ID over built-in defaults", () => {
    const qa = Work.RoleContract.make({
      id: Work.RoleID.make("qa"),
      agentID: "organization-qa",
      title: "Organization QA",
      purpose: "Apply the organization quality policy",
      capabilities: ["verify", "audit"],
      workspaceAccess: "read_only",
      allowedIsolation: ["shared"],
      accepts: ["result", "risk"],
      publishes: ["result", "fact", "risk"],
    })
    const release = Work.RoleContract.make({
      id: Work.RoleID.make("release-manager"),
      agentID: "release-manager",
      title: "Release Manager",
      purpose: "Prepare releases",
      capabilities: ["coordinate", "verify"],
      workspaceAccess: "write",
      allowedIsolation: ["shared"],
      accepts: ["result", "risk"],
      publishes: ["result", "decision", "risk"],
    })
    const contracts = WorkOrganization.merge([
      new Config.Document({
        type: "document",
        info: new Config.Info({ work: new ConfigWork.Info({ roles: [qa, release] }) }),
      }),
    ])

    expect(contracts.find((contract) => contract.id === "qa")).toEqual(qa)
    expect(contracts.find((contract) => contract.id === "release-manager")).toEqual(release)
    expect(contracts.find((contract) => contract.id === "developer")).toBeDefined()
  })
})
