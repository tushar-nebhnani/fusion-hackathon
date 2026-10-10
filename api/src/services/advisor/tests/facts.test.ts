import { describe, expect, it } from "vitest";
import { createMemoryAdvisorRepository } from "../testing/memory-repository.js";
import { getBusinessFacts, saveBusinessFact } from "../tools/memory.js";
import type { BusinessRecord } from "../types.js";

const business = { id: "B-1", formFacts: { insurance: "none" } } as unknown as BusinessRecord;

describe("business facts", () => {
  it("mark what the owner said, in chat or on the form, as owner-claimed", async () => {
    const { repo } = createMemoryAdvisorRepository();
    await saveBusinessFact(repo, "B-1", "stock_perishable", "yes, milk", "owner_chat");
    await saveBusinessFact(repo, "B-1", "storage_level", "raised racks", "bank");

    const { facts } = await getBusinessFacts(repo, business);

    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "stock_perishable", source: "owner_chat", standing: "owner_claimed" }),
        expect.objectContaining({ key: "insurance", source: "form", standing: "owner_claimed" }),
        expect.objectContaining({ key: "storage_level", source: "bank", standing: "bank_recorded" }),
      ]),
    );
  });

  it("cannot replace a fact the bank recorded from chat", async () => {
    const { repo } = createMemoryAdvisorRepository();
    await saveBusinessFact(repo, "B-1", "storage_level", "ground floor", "bank");

    await expect(saveBusinessFact(repo, "B-1", "storage_level", "raised racks", "owner_chat")).rejects.toThrow(
      /recorded by the bank/,
    );
    expect((await repo.getFacts("B-1"))[0]).toMatchObject({ value: "ground floor", source: "bank" });
  });
});
