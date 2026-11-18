/**
 * Status block of the automatic PRRO fiscalization (the Frappe app `ua_prro`).
 *
 * A site that has `ua_prro` and a POS Profile with automatic fiscalization answers `submit_invoice` with the usual
 * invoice data plus a block `ua_prro`: the invoice is submitted and the receipt was sent to the fiscal server after it.
 * A failure of that step is NOT an error of the call (the sale exists, and an error would invite a second sale), so the
 * browser has to read the block and show it. Without `ua_prro` the answer has no block and nothing here acts.
 *
 * Block: { sales_invoice, status, ok, can_retry, message, document, fiscal_number, is_fake, existing, cash }
 * status: Accepted | Rejected | Failed | Unknown | "Not Fiscalized" | Skipped
 * cash: { grand_total, rounded_total, paid_amount, change_amount } for a cash sale (the cash is rounded to 0.10 UAH
 * by the app, POS Next shows the exact total)
 *
 *
 * Profile data: `get_pos_profile_data` answers with `ua_prro: { auto: true, cash_step: "0.10" | "0.50", cash_modes: [...] }` for a
 * profile with automatic fiscalization (and with nothing for any other profile). The payment dialog uses it to show the
 * cash total as the app rounds it (see roundCash) and the change computed from it before the sale is completed.
 *
 * Kept as a small separate module so that the patch of the fork stays small and is easy to carry over upstream merges.
 */
import { ref } from "vue"
import { parseError } from "@/utils/errorHandler"

// Action name of the error dialog (uiStore.showError) for "Fiscalize again".
export const UA_PRRO_RETRY_ACTION = "ua_prro"
const FISCALIZE_METHOD = "ua_prro.prro.api.fiscalize_sales_invoice"
// After these the Fiscalize button of the invoice may try again; an Unknown receipt needs a PRRO manager.
const RETRYABLE = ["Rejected", "Failed", "Not Fiscalized"]

/** The `ua_prro` block of an answer of `submit_invoice`, or null when there is none. */
export function getUaPrroBlock(result) {
	const block = result?.ua_prro ?? result?.message?.ua_prro
	return block && typeof block === "object" ? block : null
}

function money(value) {
	return Number(value || 0).toFixed(2)
}

/**
 * What to show for a block: null (nothing), or
 * { level: "ok" | "info" | "error", title, message, details, canRetry, invoice }.
 */
export function describeUaPrro(block) {
	if (!block) return null
	const invoice = block.sales_invoice || ""
	if (block.status === "Skipped") {
		return { level: "info", message: block.message || "", invoice }
	}
	if (block.ok) {
		const parts = [__("Fiscal receipt registered")]
		if (block.fiscal_number) parts.push(block.fiscal_number)
		const cash = block.cash
		let change = ""
		// POS Next shows the exact total and the change computed from it: the cashier hands over the change of the
		// receipt, which comes first and is shown on its own.
		if (
			cash &&
			(cash.rounded_total !== cash.grand_total || cash.change_amount)
		) {
			const differs =
				cash.screen_change && cash.screen_change !== cash.change_amount
			change = differs
				? __(
						"Change to hand over: {0} (the payment screen says {1}). Receipt total {2}",
						[
							money(cash.change_amount),
							money(cash.screen_change),
							money(cash.rounded_total),
						],
					)
				: __("Change to hand over: {0}. Receipt total {1}", [
						money(cash.change_amount),
						money(cash.rounded_total),
					])
		}
		return { level: "ok", message: parts.join(". "), change, invoice }
	}
	const retry = Boolean(block.can_retry)
	const hint =
		block.status === "Unknown"
			? __(
					"The outcome is not known: ask a PRRO manager to check the document before anything is repeated.",
				)
			: retry
				? __(
						"Press Fiscalize again, or fiscalize the invoice later from its form.",
					)
				: ""
	return {
		level: "error",
		title: __("Fiscal receipt not registered"),
		message:
			block.message || __("The fiscal server did not register the receipt."),
		details: [__("The sale {0} is saved.", [invoice]), hint]
			.filter(Boolean)
			.join(" "),
		canRetry: retry,
		invoice,
	}
}

/** The block of the answer of the endpoint `fiscalize_sales_invoice` (the answer of the button of the invoice). */
export function blockFromOutcome(outcome, invoice) {
	const status = outcome?.status || "Not Fiscalized"
	return {
		sales_invoice: invoice,
		status,
		ok: status === "Accepted",
		can_retry: RETRYABLE.includes(status),
		message: outcome?.message || "",
		document: outcome?.document || null,
		fiscal_number: outcome?.fiscal_number || null,
		is_fake: Boolean(outcome?.is_fake),
		existing: Boolean(outcome?.existing),
		cash: null,
	}
}

/**
 * "Fiscalize again": the endpoint of the Fiscalize button of the invoice. Never throws: a refusal (no open PRRO shift,
 * a pre-check) is a block with the text of the server.
 * @param {(method: string, args: object) => Promise<any>} call - the API caller of the app
 */
export async function fiscalizeAgain(call, invoice) {
	try {
		const answer = await call(FISCALIZE_METHOD, { sales_invoice: invoice })
		// The caller may give the whole response ({message: {...}}) or the message itself.
		const outcome =
			answer && typeof answer.message === "object" ? answer.message : answer
		return blockFromOutcome(outcome, invoice)
	} catch (error) {
		return {
			...blockFromOutcome({ status: "Not Fiscalized" }, invoice),
			message: parseError(error).message,
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Cash rounding (the rule of ua_prro: prro_core/money.py round_cash and PRRO Settings "cash_rounding_step")
// ---------------------------------------------------------------------------------------------------------------------

// The steps the law allows (NBU resolution No. 25 of 15.03.2018: 0.10 UAH, since 2025-10-01 also 0.50 UAH), in kopecks.
const CASH_STEPS = { "0.10": 10, "0.50": 50 }

/** The amount in whole kopecks (an integer); a float such as 4.35 * 100 = 434.99999999999994 is taken as 435. */
export function toKopecks(value) {
	const amount = Number(value)
	if (!Number.isFinite(amount)) return 0
	return Math.sign(amount) * Math.round(Math.abs(amount) * 100 + 1e-7)
}

/**
 * Round a cash total to the step ("0.10" or "0.50"), exactly as the server does: the nearest multiple, an exact half
 * goes AWAY from zero (12.35 -> 12.40, -12.35 -> -12.40, 12.25 at 0.50 -> 12.50), the arithmetic in integer kopecks.
 * An unknown step leaves the amount as it is (to two decimals). Never returns -0.
 */
export function roundCash(value, step) {
	const kopecks = toKopecks(value)
	const unit = CASH_STEPS[step]
	if (!unit) return kopecks / 100 || 0
	const units = Math.floor((2 * Math.abs(kopecks) + unit) / (2 * unit))
	const rounded = Math.sign(kopecks) * units * unit
	return rounded / 100 || 0
}

// What the server said about the POS Profiles of this session: { [profile]: { auto: true, cashStep: "0.10" } }.
const profileConfig = ref({})

/**
 * Remember the block `ua_prro` of `get_pos_profile_data` for a profile. Anything but an automatic profile with a known
 * step (an older app, a site without ua_prro, a profile without the option) clears it: nothing here then acts.
 */
export function setUaPrroConfig(profile, block) {
	if (!profile) return
	const next = { ...profileConfig.value }
	if (block && block.auto === true && CASH_STEPS[block.cash_step]) {
		// cash_modes: the Modes of Payment whose PRRO Payment Form is cash (the server's rule); absent: unknown.
		const modes = Array.isArray(block.cash_modes)
			? block.cash_modes.filter((mode) => typeof mode === "string")
			: null
		next[profile] = { auto: true, cashStep: block.cash_step, cashModes: modes }
	} else {
		delete next[profile]
	}
	profileConfig.value = next
}

/** The cash rounding step ("0.10" | "0.50") of an automatic profile, or null. Reactive. */
export function getUaPrroCashStep(profile) {
	return profileConfig.value[profile]?.cashStep || null
}

/** The Modes of Payment that the server treats as cash for an automatic profile, or null when it did not say. */
export function getUaPrroCashModes(profile) {
	return profileConfig.value[profile]?.cashModes || null
}

/**
 * Is a Mode of Payment (an object with `mode_of_payment` and maybe `type` / `account_type`) cash for the rounding:
 * the server's list of the profile when it sent one, else the type or the name. The rows of the POS Profile that the
 * return dialog has carry no type, only the mode name: the server's list is what makes them known.
 */
export function isCashMode(profile, method) {
	if (!method) return false
	const modes = getUaPrroCashModes(profile)
	if (modes) return modes.includes(method.mode_of_payment)
	const kind = `${method.account_type || ""} ${method.type || ""}`.toLowerCase()
	return kind.includes("cash") || (method.mode_of_payment || "").toLowerCase().includes("cash")
}

/**
 * The total the cashier takes in cash: the exact total rounded by the step of the app for an automatic profile and a
 * cash-only payment, else the total itself. The server stays authoritative.
 */
export function cashPayableTotal(total, step, isCash) {
	return step && isCash ? roundCash(total, step) : total
}

/** The block after "Fiscalize again": the answer of the button has no cash figures, the sale's own stay. */
export function mergeRetriedBlock(previous, fresh) {
	return { ...fresh, cash: previous?.cash ?? fresh.cash ?? null }
}

/**
 * The sale-complete view of a block: { level: "ok" | "error" | "info", changeAmount, receiptTotal, fiscalNumber, isFake,
 * title, message, details, canRetry, invoice } or null. The change to hand over is the server's figure (the receipt's).
 */
export function describeSale(block) {
	const view = describeUaPrro(block)
	if (!view) return null
	const cash = block.cash
	return {
		...view,
		changeAmount: cash ? Number(cash.change_amount || 0) : null,
		receiptTotal: cash ? Number(cash.rounded_total) : null,
		fiscalNumber: block.fiscal_number || "",
		isFake: Boolean(block.is_fake),
	}
}

/**
 * The cash to hand back for a refund of `returnTotal` through ONE cash payment row, as the receipt of the return will
 * have it (rounded by the step of the app, half away from zero), or null: not an automatic profile, not one cash row,
 * or the rounding changes nothing. The row's mode is cash by the server's list; `methods` (the rows of the POS Profile,
 * maybe with a type) only add what the row itself lacks.
 */
export function uaPrroRefundHint(profile, returnTotal, refundPayments, methods) {
	const step = getUaPrroCashStep(profile)
	if (!step || !Array.isArray(refundPayments) || refundPayments.length !== 1) return null
	if (!(returnTotal > 0)) return null
	const row = refundPayments[0]
	const known = (methods || []).find((m) => m.mode_of_payment === row.mode_of_payment)
	if (!isCashMode(profile, { ...known, mode_of_payment: row.mode_of_payment })) return null
	const rounded = roundCash(returnTotal, step)
	return rounded === roundCash(returnTotal, null) ? null : rounded
}
