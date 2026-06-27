import { describe, expect, it } from "vitest";
import { blockEnvelope, eventRowsFromBlock } from "@/lib/chainhookPayload";

// CONTRACT_ID and EVENT_TOPIC are unset in the test environment, so the
// contract/topic filters are skipped and any decoded print event passes. These
// tests exercise the payload-shape handling, not the env filters.

const value = { event: "anchor-created", hash: "0xabc" };

function receiptTx(txId: string) {
  return {
    transaction_identifier: { hash: txId },
    metadata: {
      success: true,
      sender: "SP-sender",
      receipt: {
        events: [
          {
            type: "SmartContractEvent",
            data: { contract_identifier: "SP.c", topic: "print", value },
          },
        ],
      },
    },
  };
}

function operationTx(txId: string) {
  return {
    transaction_identifier: { hash: txId },
    metadata: { success: true, sender: "SP-sender" },
    operations: [
      {
        type: "contract_log",
        metadata: { contract_identifier: "SP.c", topic: "print", value },
      },
    ],
  };
}

describe("eventRowsFromBlock", () => {
  it("reads a print event from receipt.events (SmartContractEvent)", () => {
    const rows = eventRowsFromBlock({
      block_identifier: { index: 42 },
      transactions: [receiptTx("0x01")],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tx_id: "0x01",
      block_height: 42,
      sender: "SP-sender",
      topic: "anchor-created",
      reverted: false,
    });
  });

  it("reads a print event from operations (contract_log)", () => {
    const rows = eventRowsFromBlock({
      block_identifier: { index: 7 },
      transactions: [operationTx("0x02")],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tx_id: "0x02", topic: "anchor-created" });
  });

  it("de-duplicates the same event carried by both shapes in one transaction", () => {
    const tx = {
      transaction_identifier: { hash: "0x03" },
      metadata: {
        success: true,
        receipt: {
          events: [
            {
              type: "SmartContractEvent",
              data: { contract_identifier: "SP.c", topic: "print", value },
            },
          ],
        },
      },
      operations: [
        {
          type: "contract_log",
          metadata: { contract_identifier: "SP.c", topic: "print", value },
        },
      ],
    };
    const rows = eventRowsFromBlock({
      block_identifier: { index: 9 },
      transactions: [tx],
    });
    expect(rows).toHaveLength(1);
  });

  it("skips failed transactions", () => {
    const tx = receiptTx("0x04");
    tx.metadata.success = false;
    const rows = eventRowsFromBlock({
      block_identifier: { index: 1 },
      transactions: [tx],
    });
    expect(rows).toHaveLength(0);
  });

  it("ignores non-print and non-matching event shapes", () => {
    const rows = eventRowsFromBlock({
      block_identifier: { index: 1 },
      transactions: [
        {
          transaction_identifier: { hash: "0x05" },
          metadata: {
            success: true,
            receipt: {
              events: [
                {
                  type: "STXTransferEvent",
                  data: { contract_identifier: "SP.c", topic: "print", value },
                },
              ],
            },
          },
          operations: [
            {
              type: "stx_transfer",
              metadata: { contract_identifier: "SP.c", topic: "print", value },
            },
          ],
        },
      ],
    });
    expect(rows).toHaveLength(0);
  });
});

describe("blockEnvelope", () => {
  it("returns top-level apply/rollback when present", () => {
    const apply = [{ block_identifier: { index: 1 } }];
    const env = blockEnvelope({ apply, rollback: [] });
    expect(env.apply).toBe(apply);
  });

  it("unwraps a nested event envelope", () => {
    const apply = [{ block_identifier: { index: 2 } }];
    const env = blockEnvelope({ event: { apply, rollback: [] } });
    expect(env.apply).toBe(apply);
  });
});
