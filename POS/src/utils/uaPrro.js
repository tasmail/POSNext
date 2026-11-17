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
 * Kept as a small separate module so that the patch of the fork stays small and is easy to carry over upstream merges.
 */
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
