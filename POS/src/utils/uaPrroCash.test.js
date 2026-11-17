import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import vectors from "./uaPrroCashVectors.json"

// `__` is the translation function of the app (a global); the tests use its placeholders as they are.
beforeEach(() => {
	globalThis.__ = (text, args = []) =>
		text.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)]))
})

vi.mock("@/utils/errorHandler", () => ({
	parseError: (error) => ({ message: error?.message || "error" }),
}))

const {
	cashPayableTotal,
	describeSale,
	getUaPrroCashModes,
	getUaPrroCashStep,
	mergeRetriedBlock,
	roundCash,
	setUaPrroConfig,
	toKopecks,
} = await import("./uaPrro")

// The vectors are the file of `ua_prro` (tests/data/cash_rounding_vectors.json), which its own test feeds to the
// Python rounding of the receipts (prro_core/money.py round_cash): this is the same list on the JS side.
describe("roundCash against the vectors of the server", () => {
	it("has a meaningful list", () => {
		expect(vectors.length).toBeGreaterThanOrEqual(40)
	})
	for (const row of vectors) {
		it(`${row.value} at ${row.step} is ${row.expected}`, () => {
			expect(roundCash(Number(row.value), row.step)).toBe(Number(row.expected))
			// The amount may also come as a string of the API.
			expect(roundCash(row.value, row.step)).toBe(Number(row.expected))
		})
	}
})

describe("roundCash, the named cases", () => {
	it("goes half away from zero at 0.10", () => {
		expect(roundCash(12.35, "0.10")).toBe(12.4)
		expect(roundCash(12.34, "0.10")).toBe(12.3)
		expect(roundCash(-12.35, "0.10")).toBe(-12.4)
	})
	it("handles the step 0.50", () => {
		expect(roundCash(12.25, "0.50")).toBe(12.5)
		expect(roundCash(12.75, "0.50")).toBe(13)
		expect(roundCash(-12.75, "0.50")).toBe(-13)
	})
	it("handles the 0.05 boundaries and never returns -0", () => {
		expect(roundCash(0.05, "0.10")).toBe(0.1)
		expect(roundCash(0.04, "0.10")).toBe(0)
		expect(Object.is(roundCash(-0.04, "0.10"), 0)).toBe(true)
		expect(roundCash(-0.05, "0.10")).toBe(-0.1)
		expect(Object.is(roundCash(0, "0.10"), 0)).toBe(true)
	})
	it("takes the float traps as the decimal they stand for", () => {
		// 4.35 * 100 = 434.99999999999994, 1.005 * 100 = 100.49999999999999
		expect(toKopecks(4.35)).toBe(435)
		expect(roundCash(4.35, "0.10")).toBe(4.4)
		expect(roundCash(8.05, "0.10")).toBe(8.1)
		expect(roundCash(0.15, "0.10")).toBe(0.2)
		expect(roundCash(1000000.05, "0.10")).toBe(1000000.1)
	})
	it("leaves the amount alone for an unknown step", () => {
		expect(roundCash(12.35, "0.25")).toBe(12.35)
		expect(roundCash(12.35, null)).toBe(12.35)
	})
})

// The whole grid of the server: every kopeck from -200.00 to 200.00 at both steps. The file is written by
// `python scripts/cash_rounding_contract.py <file>` in the app; run `UA_PRRO_CASH_CONTRACT=<file> npm run test:run`.
describe.skipIf(!process.env.UA_PRRO_CASH_CONTRACT)("contract with the Python rounding of ua_prro", () => {
	it("gives the same amount for every kopeck at both steps", () => {
		const rows = JSON.parse(readFileSync(process.env.UA_PRRO_CASH_CONTRACT, "utf8"))
		expect(rows.length).toBe(2 * 40001)
		// Object.is: a -0 would be a difference (the grid writes a negative zero as "0.00").
		const wrong = rows.filter(
			(row) => !Object.is(roundCash(row.value, row.step), Number(row.expected)),
		)
		expect(wrong.slice(0, 5)).toEqual([])
	})
})

describe("the profile configuration", () => {
	it("is set for an automatic profile only", () => {
		setUaPrroConfig("Shop", { auto: true, cash_step: "0.10" })
		expect(getUaPrroCashStep("Shop")).toBe("0.10")
		setUaPrroConfig("Shop", { auto: true, cash_step: "0.50" })
		expect(getUaPrroCashStep("Shop")).toBe("0.50")
	})
	it("is cleared by an answer without the block (an older app, another profile)", () => {
		setUaPrroConfig("Shop", { auto: true, cash_step: "0.10" })
		setUaPrroConfig("Shop", undefined)
		expect(getUaPrroCashStep("Shop")).toBeNull()
	})
	it("refuses what the server does not send", () => {
		for (const block of [
			{ auto: false, cash_step: "0.10" },
			{ auto: true, cash_step: "0.25" },
			{ auto: true },
			"x",
			null,
		]) {
			setUaPrroConfig("Shop", block)
			expect(getUaPrroCashStep("Shop")).toBeNull()
		}
		expect(getUaPrroCashStep("Never Seen")).toBeNull()
		expect(getUaPrroCashStep(undefined)).toBeNull()
	})
})

describe("the cash modes of the profile", () => {
	it("are kept when the server sends a list, else unknown", () => {
		setUaPrroConfig("Shop", { auto: true, cash_step: "0.10", cash_modes: ["Cash", 5] })
		expect(getUaPrroCashModes("Shop")).toEqual(["Cash"])
		setUaPrroConfig("Shop", { auto: true, cash_step: "0.10" })
		expect(getUaPrroCashModes("Shop")).toBeNull()
		expect(getUaPrroCashModes("Never Seen")).toBeNull()
	})
})

describe("the payment dialog arithmetic", () => {
	it("rounds only a cash sale of an automatic profile", () => {
		expect(cashPayableTotal(12.35, "0.10", true)).toBe(12.4)
		expect(cashPayableTotal(12.35, "0.10", false)).toBe(12.35)
		expect(cashPayableTotal(12.35, null, true)).toBe(12.35)
	})
	it("computes the change from the rounded total, as the receipt does", () => {
		const payable = cashPayableTotal(12.35, "0.10", true)
		// 20.00 tendered: the receipt says 7.60 (the screen of POS Next said 7.65)
		expect(roundCash(20 - payable, "0.10")).toBe(7.6)
		expect(Math.round((20 - payable) * 100) / 100).toBe(7.6)
	})
})

describe("describeSale", () => {
	const accepted = {
		sales_invoice: "SINV-1",
		status: "Accepted",
		ok: true,
		can_retry: false,
		message: "",
		fiscal_number: "4000.12.3",
		is_fake: true,
		cash: {
			grand_total: 12.35,
			rounded_total: 12.4,
			paid_amount: 20,
			change_amount: 7.6,
			screen_change: 7.65,
		},
	}
	it("has the change to hand over, the receipt total and the fiscal number", () => {
		const view = describeSale(accepted)
		expect(view).toMatchObject({
			level: "ok",
			changeAmount: 7.6,
			receiptTotal: 12.4,
			fiscalNumber: "4000.12.3",
			isFake: true,
		})
	})
	it("has no change for a card sale", () => {
		expect(describeSale({ ...accepted, cash: null }).changeAmount).toBeNull()
	})
	it("is an error that can be repeated, with the change still shown", () => {
		const view = describeSale({
			...accepted,
			status: "Failed",
			ok: false,
			can_retry: true,
			message: "No connection",
			fiscal_number: null,
		})
		expect(view).toMatchObject({ level: "error", canRetry: true, changeAmount: 7.6 })
		expect(view.message).toBe("No connection")
	})
	it("is nothing without a block", () => {
		expect(describeSale(null)).toBeNull()
	})
})

describe("mergeRetriedBlock", () => {
	it("keeps the cash figures of the sale, the answer of the button has none", () => {
		const previous = { cash: { change_amount: 7.6, rounded_total: 12.4 } }
		const fresh = { status: "Accepted", ok: true, cash: null, fiscal_number: "9" }
		expect(mergeRetriedBlock(previous, fresh)).toEqual({
			status: "Accepted",
			ok: true,
			cash: previous.cash,
			fiscal_number: "9",
		})
	})
})
