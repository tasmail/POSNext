// @vitest-environment jsdom
// The payment dialog of an automatic PRRO profile: the cash total is rounded by the app's rule before the sale is
// completed, and the change is computed from it (12.35 -> 12.40, 20.00 tendered -> 7.60, not 7.65).
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h } from "vue"

const translate = (text, args = []) =>
	text.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)]))

const setUaPrroCashSet = (profile, modes) =>
	setUaPrroConfig(profile, { auto: true, cash_step: "0.10", cash_modes: modes })

const METHODS = [
	{ mode_of_payment: "Cash", default: 1, type: "Cash", account_type: "Cash" },
	{ mode_of_payment: "Card", default: 0, type: "Bank", account_type: "Bank" },
]

const ORIGINAL_METHODS = [...METHODS]

vi.mock("frappe-ui", () => {
	const passthrough = (name) =>
		defineComponent({
			name,
			setup(_props, { slots, attrs }) {
				return () =>
					h(
						"div",
						attrs,
						[
							slots["body-content"]?.(),
							slots.default?.(),
							slots.actions?.(),
						],
					)
			},
		})
	return {
		Dialog: passthrough("Dialog"),
		Button: passthrough("Button"),
		FeatherIcon: passthrough("FeatherIcon"),
		call: vi.fn().mockResolvedValue([]),
		// A resource that answers its own `onSuccess` with the fixture of its url.
		createResource: (options) => ({
			data: null,
			loading: false,
			async fetch() {
				const data = options.url.endsWith("get_payment_methods") ? METHODS : []
				options.onSuccess?.(data)
				return data
			},
			async submit() {
				return null
			},
			reload() {},
		}),
	}
})
vi.mock("@/utils/offline/workerClient", () => ({
	offlineWorker: new Proxy({}, { get: () => async () => [] }),
}))
vi.mock("@/utils/errorHandler", () => ({
	parseError: (error) => ({ message: error?.message || "error" }),
}))

const { default: PaymentDialog } = await import("./PaymentDialog.vue")
const { setUaPrroConfig } = await import("@/utils/uaPrro")

async function open(props = {}) {
	const wrapper = mount(PaymentDialog, {
		props: {
			modelValue: true,
			grandTotal: 12.35,
			subtotal: 12.35,
			posProfile: "Shop",
			currency: "UAH",
			company: "Co",
			...props,
		},
		global: { mocks: { __: translate } },
	})
	await flushPromises()
	await wrapper.vm.$nextTick()
	return wrapper
}

beforeEach(() => {
	globalThis.__ = translate
	setActivePinia(createPinia())
	setUaPrroConfig("Shop", undefined)
	setUaPrroConfig("Plain", undefined)
})

// The dialog exposes nothing: read its rendered figures.
const text = (wrapper) => wrapper.text().replace(/\s+/g, " ")

describe("PaymentDialog with the cash rounding of an automatic PRRO profile", () => {
	it("shows the rounded cash total and asks the rounded amount", async () => {
		setUaPrroConfig("Shop", { auto: true, cash_step: "0.10" })
		const wrapper = await open()
		const cash = wrapper.get('[data-testid="ua-prro-cash-total"]').text()
		expect(cash).toContain("Cash total (rounded to 0.10)")
		expect(cash).toMatch(/12\.40/)
		// "Remaining" is the rounded total, not 12.35.
		expect(text(wrapper)).toMatch(/Remaining\s*\S*\s*12\.40/)
	})

	it("computes the change from the rounded total before the sale is completed", async () => {
		setUaPrroConfig("Shop", { auto: true, cash_step: "0.10" })
		const wrapper = await open()
		wrapper.vm.paymentEntries = [{ mode_of_payment: "Cash", amount: 20, type: "Cash" }]
		await wrapper.vm.$nextTick()
		expect(text(wrapper)).toMatch(/Change Due\s*\S*\s*7\.60/)
		expect(text(wrapper)).not.toMatch(/7\.65/)
	})

	it("is fully paid with the rounded amount, also when it is below the exact total", async () => {
		setUaPrroConfig("Shop", { auto: true, cash_step: "0.10" })
		const wrapper = await open({ grandTotal: 12.34, subtotal: 12.34 })
		expect(wrapper.get('[data-testid="ua-prro-cash-total"]').text()).toMatch(/12\.30/)
		wrapper.vm.paymentEntries = [{ mode_of_payment: "Cash", amount: 12.3, type: "Cash" }]
		await wrapper.vm.$nextTick()
		expect(text(wrapper)).toContain("Fully Paid")
		wrapper.vm.completePayment()
		const [[paid]] = wrapper.emitted("payment-completed")
		expect(paid).toMatchObject({ paid_amount: 12.3, change_amount: 0, is_partial_payment: false })
	})

	it("uses the step of 0.50", async () => {
		setUaPrroConfig("Shop", { auto: true, cash_step: "0.50" })
		const wrapper = await open({ grandTotal: 12.25, subtotal: 12.25 })
		expect(wrapper.get('[data-testid="ua-prro-cash-total"]').text()).toMatch(/12\.50/)
	})

	it("never rounds a card", async () => {
		setUaPrroConfig("Shop", { auto: true, cash_step: "0.10" })
		const wrapper = await open()
		wrapper.vm.lastSelectedMethod = METHODS[1]
		await wrapper.vm.$nextTick()
		expect(wrapper.find('[data-testid="ua-prro-cash-total"]').exists()).toBe(false)
		expect(text(wrapper)).toMatch(/Remaining\s*\S*\s*12\.35/)
		wrapper.vm.paymentEntries = [{ mode_of_payment: "Card", amount: 12.35, type: "Bank" }]
		await wrapper.vm.$nextTick()
		expect(text(wrapper)).toContain("Fully Paid")
	})

	it("is a mixed sale, at the exact total, once a card is chosen after a cash entry", async () => {
		setUaPrroConfig("Shop", { auto: true, cash_step: "0.10" })
		const wrapper = await open()
		wrapper.vm.paymentEntries = [{ mode_of_payment: "Cash", amount: 5, type: "Cash" }]
		wrapper.vm.lastSelectedMethod = METHODS[1]
		await wrapper.vm.$nextTick()
		expect(wrapper.find('[data-testid="ua-prro-cash-total"]').exists()).toBe(false)
		expect(text(wrapper)).toMatch(/Remaining\s*\S*\s*7\.35/)
		wrapper.vm.paymentEntries = [
			{ mode_of_payment: "Cash", amount: 5, type: "Cash" },
			{ mode_of_payment: "Card", amount: 7.35, type: "Bank" },
		]
		await wrapper.vm.$nextTick()
		expect(text(wrapper)).toContain("Fully Paid")
		expect(text(wrapper)).not.toContain("Change Due")
		wrapper.vm.completePayment()
		const [[paid]] = wrapper.emitted("payment-completed")
		expect(paid).toMatchObject({ paid_amount: 12.35, change_amount: 0, is_partial_payment: false })
	})

	it("takes the cash modes of the server instead of the name heuristic", async () => {
		// "Готівка" has no "cash" in its name or type: only the server's list makes it cash.
		const methods = [
			{ mode_of_payment: "Готівка", default: 1, type: "General", account_type: "" },
			{ mode_of_payment: "Cash Card", default: 0, type: "Bank", account_type: "Bank" },
		]
		METHODS.splice(0, METHODS.length, ...methods)
		try {
			setUaPrroCashSet("Shop", ["Готівка"])
			const wrapper = await open()
			expect(wrapper.get('[data-testid="ua-prro-cash-total"]').text()).toMatch(/12\.40/)
			// The name "Cash Card" would pass the heuristic but the server does not call it cash.
			wrapper.vm.lastSelectedMethod = methods[1]
			await wrapper.vm.$nextTick()
			expect(wrapper.find('[data-testid="ua-prro-cash-total"]').exists()).toBe(false)
			// Without the list the heuristic decides: "Cash Card" is cash, "Готівка" is not.
			setUaPrroConfig("Shop", { auto: true, cash_step: "0.10" })
			wrapper.vm.lastSelectedMethod = methods[0]
			await wrapper.vm.$nextTick()
			expect(wrapper.find('[data-testid="ua-prro-cash-total"]').exists()).toBe(false)
		} finally {
			METHODS.splice(0, METHODS.length, ...ORIGINAL_METHODS)
		}
	})

	it("changes nothing for a profile without automatic fiscalization", async () => {
		const wrapper = await open({ posProfile: "Plain" })
		expect(wrapper.find('[data-testid="ua-prro-cash-total"]').exists()).toBe(false)
		wrapper.vm.paymentEntries = [{ mode_of_payment: "Cash", amount: 20, type: "Cash" }]
		await wrapper.vm.$nextTick()
		expect(text(wrapper)).toMatch(/Change Due\s*\S*\s*7\.65/)
	})
})
