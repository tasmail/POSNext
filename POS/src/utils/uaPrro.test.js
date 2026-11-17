import { beforeEach, describe, expect, it, vi } from "vitest"

// `__` is the translation function of the app (a global); the tests use its placeholders as they are.
beforeEach(() => {
	globalThis.__ = (text, args = []) =>
		text.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)]))
})

vi.mock("@/utils/errorHandler", () => ({
	parseError: (error) => ({ message: error?.message || "error" }),
}))

const { blockFromOutcome, describeUaPrro, fiscalizeAgain, getUaPrroBlock } =
	await import("./uaPrro")

const accepted = {
	sales_invoice: "SINV-1",
	status: "Accepted",
	ok: true,
	can_retry: false,
	message: "",
	fiscal_number: "4000.12.3",
	cash: {
		grand_total: 12.35,
		rounded_total: 12.4,
		paid_amount: 20,
		change_amount: 7.6,
		screen_change: 7.65,
	},
}

describe("getUaPrroBlock", () => {
	it("finds the block in the answer and in a wrapped answer", () => {
		expect(getUaPrroBlock({ name: "SINV-1", ua_prro: accepted })).toBe(accepted)
		expect(getUaPrroBlock({ message: { ua_prro: accepted } })).toBe(accepted)
	})
	it("is null without the app", () => {
		expect(getUaPrroBlock({ name: "SINV-1" })).toBeNull()
		expect(getUaPrroBlock(null)).toBeNull()
		expect(getUaPrroBlock({ ua_prro: "x" })).toBeNull()
	})
})

describe("describeUaPrro", () => {
	it("shows nothing without a block", () => {
		expect(describeUaPrro(null)).toBeNull()
	})
	it("puts the change to hand over first and says what the payment screen shows", () => {
		const view = describeUaPrro(accepted)
		expect(view.level).toBe("ok")
		expect(view.message).toBe("Fiscal receipt registered. 4000.12.3")
		expect(view.change).toBe(
			"Change to hand over: 7.60 (the payment screen says 7.65). Receipt total 12.40",
		)
	})
	it("has the receipt total for an exact tender that was rounded", () => {
		const view = describeUaPrro({
			...accepted,
			cash: {
				change_amount: 0,
				screen_change: 0,
				rounded_total: 12.4,
				grand_total: 12.35,
				paid_amount: 12.4,
			},
		})
		expect(view.change).toBe("Change to hand over: 0.00. Receipt total 12.40")
	})
	it("has no change line when POS Next showed the same", () => {
		const view = describeUaPrro({
			...accepted,
			cash: {
				change_amount: 0,
				screen_change: 0,
				rounded_total: 12.4,
				grand_total: 12.4,
				paid_amount: 12.4,
			},
		})
		expect(view.change).toBe("")
	})
	it("is an error with a retry for a rejected receipt, and says the sale is saved", () => {
		const view = describeUaPrro({
			sales_invoice: "SINV-2",
			status: "Rejected",
			ok: false,
			can_retry: true,
			message: "Код помилки: 4",
		})
		expect(view.level).toBe("error")
		expect(view.canRetry).toBe(true)
		expect(view.message).toBe("Код помилки: 4")
		expect(view.details).toContain("The sale SINV-2 is saved.")
		expect(view.details).toContain("Fiscalize again")
	})
	it("offers no retry for an unknown outcome and points to a manager", () => {
		const view = describeUaPrro({
			sales_invoice: "SINV-3",
			status: "Unknown",
			ok: false,
			can_retry: false,
		})
		expect(view.canRetry).toBe(false)
		expect(view.details).toContain("PRRO manager")
		expect(view.message).toBe("The fiscal server did not register the receipt.")
	})
	it("is a notice for a skipped return", () => {
		const view = describeUaPrro({
			sales_invoice: "SINV-4",
			status: "Skipped",
			ok: true,
			message: "not fiscalized",
		})
		expect(view).toEqual({
			level: "info",
			message: "not fiscalized",
			invoice: "SINV-4",
		})
	})
})

describe("fiscalizeAgain", () => {
	it("turns the answer of the endpoint into a block", async () => {
		const call = vi.fn().mockResolvedValue({
			status: "Accepted",
			document: "PRRO-1",
			fiscal_number: "9",
			message: "",
		})
		const block = await fiscalizeAgain(call, "SINV-1")
		expect(call).toHaveBeenCalledWith(
			"ua_prro.prro.api.fiscalize_sales_invoice",
			{ sales_invoice: "SINV-1" },
		)
		expect(block).toMatchObject({
			ok: true,
			can_retry: false,
			status: "Accepted",
			fiscal_number: "9",
		})
	})
	it("takes the message of a wrapped response", async () => {
		const call = vi
			.fn()
			.mockResolvedValue({ message: { status: "Rejected", message: "no" } })
		expect(await fiscalizeAgain(call, "SINV-1")).toMatchObject({
			status: "Rejected",
			can_retry: true,
			message: "no",
		})
	})
	it("never throws: a refusal is a block with its text", async () => {
		const call = vi.fn().mockRejectedValue(new Error("Open a PRRO shift first"))
		const block = await fiscalizeAgain(call, "SINV-1")
		expect(block).toMatchObject({
			ok: false,
			status: "Not Fiscalized",
			can_retry: true,
			message: "Open a PRRO shift first",
		})
	})
	it("keeps an unknown status out of the retry", () => {
		expect(blockFromOutcome({ status: "Unknown" }, "SINV-1").can_retry).toBe(
			false,
		)
	})
})
