// @vitest-environment jsdom
import { mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h } from "vue"

// `__` is a global of the app (script and template): the tests give it to both.
const translate = (text, args = []) =>
	text.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)]))
beforeEach(() => {
	globalThis.__ = translate
})

vi.mock("@/utils/errorHandler", () => ({
	parseError: (error) => ({ message: error?.message || "error" }),
}))
// A plain button: the real one needs the whole of frappe-ui.
vi.mock("frappe-ui", () => ({
	Button: defineComponent({
		props: { loading: Boolean, disabled: Boolean },
		emits: ["click"],
		setup(props, { slots, emit, attrs }) {
			return () =>
				h(
					"button",
					{
						...attrs,
						disabled: props.disabled,
						onClick: () => emit("click"),
					},
					slots.default?.(),
				)
		},
	}),
}))

const { default: UaPrroSaleStatus } = await import("./UaPrroSaleStatus.vue")
const mountStatus = (options) =>
	mount(UaPrroSaleStatus, { ...options, global: { mocks: { __: translate } } })

const sale = {
	sales_invoice: "SINV-1",
	status: "Accepted",
	ok: true,
	can_retry: false,
	message: "",
	fiscal_number: "4000.12.3",
	is_fake: true,
	cash: { grand_total: 12.35, rounded_total: 12.4, paid_amount: 20, change_amount: 7.6 },
}

describe("UaPrroSaleStatus", () => {
	it("shows nothing without a block", () => {
		const wrapper = mountStatus({ props: { block: null } })
		expect(wrapper.find('[data-testid="ua-prro-status"]').exists()).toBe(false)
	})

	it("shows the change to hand over first, the receipt total and the fiscal number", () => {
		const wrapper = mountStatus({ props: { block: sale } })
		const change = wrapper.get('[data-testid="ua-prro-change"]').text()
		expect(change).toContain("Change to hand over")
		expect(change).toMatch(/7\.60/)
		expect(change).toContain("Receipt total")
		expect(change).toMatch(/12\.40/)
		const ok = wrapper.get('[data-testid="ua-prro-ok"]').text()
		expect(ok).toContain("Fiscal receipt registered")
		expect(ok).toContain("4000.12.3")
		expect(ok).toContain("Test receipt")
		expect(wrapper.find('[data-testid="ua-prro-error"]').exists()).toBe(false)
		// The change box comes before the fiscal box.
		const html = wrapper.html()
		expect(html.indexOf("ua-prro-change")).toBeLessThan(html.indexOf("ua-prro-ok"))
	})

	it("says there is no change for an exact payment and shows nothing about change for a card", () => {
		const exact = mountStatus({
			props: { block: { ...sale, cash: { ...sale.cash, change_amount: 0 } } },
		})
		expect(exact.get('[data-testid="ua-prro-change"]').text()).toContain("No change")
		const card = mountStatus({ props: { block: { ...sale, cash: null } } })
		expect(card.find('[data-testid="ua-prro-change"]').exists()).toBe(false)
	})

	it("shows a persistent error with the retry when the receipt was not registered", async () => {
		const failed = {
			...sale,
			status: "Failed",
			ok: false,
			can_retry: true,
			message: "No connection to the fiscal server",
			fiscal_number: null,
		}
		const wrapper = mountStatus({ props: { block: failed } })
		const error = wrapper.get('[data-testid="ua-prro-error"]')
		expect(error.attributes("role")).toBe("alert")
		expect(error.text()).toContain("Fiscal receipt not registered")
		expect(error.text()).toContain("No connection to the fiscal server")
		expect(error.text()).toContain("The sale SINV-1 is saved.")
		// The change is still there: the customer was served.
		expect(wrapper.get('[data-testid="ua-prro-change"]').text()).toMatch(/7\.60/)
		expect(wrapper.find('[data-testid="ua-prro-ok"]').exists()).toBe(false)
		await wrapper.get('[data-testid="ua-prro-retry"]').trigger("click")
		expect(wrapper.emitted("retry")).toHaveLength(1)
	})

	it("disables the retry while it runs, and has none for an unknown outcome", async () => {
		const failed = { ...sale, status: "Failed", ok: false, can_retry: true, message: "x" }
		const busy = mountStatus({ props: { block: failed, retrying: true } })
		expect(busy.get('[data-testid="ua-prro-retry"]').attributes("disabled")).toBeDefined()
		const unknown = mountStatus({
			props: { block: { ...failed, status: "Unknown", can_retry: false } },
		})
		expect(unknown.find('[data-testid="ua-prro-retry"]').exists()).toBe(false)
		expect(unknown.get('[data-testid="ua-prro-error"]').text()).toContain("PRRO manager")
	})
})
