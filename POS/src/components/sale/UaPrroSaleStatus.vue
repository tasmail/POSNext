<template>
	<div v-if="view" class="mt-4 flex flex-col gap-3 text-start" data-testid="ua-prro-status">
		<!-- What the cashier hands over: the figure of the receipt, first and large -->
		<div
			v-if="view.changeAmount !== null"
			class="rounded-lg border border-green-200 bg-green-50 p-4 text-center"
			data-testid="ua-prro-change"
		>
			<div class="text-xs font-semibold uppercase tracking-wide text-green-700">
				{{ __("Change to hand over") }}
			</div>
			<div class="mt-1 text-3xl font-bold text-green-700">
				{{ view.changeAmount > 0 ? formatCurrency(view.changeAmount, currency) : __("No change") }}
			</div>
			<div class="mt-1 text-xs text-green-700">
				{{ __("Receipt total {0}", [formatCurrency(view.receiptTotal, currency)]) }}
			</div>
		</div>

		<!-- The fiscal receipt registered -->
		<div
			v-if="view.level === 'ok'"
			class="rounded-lg border border-gray-200 bg-white p-3"
			data-testid="ua-prro-ok"
		>
			<div class="flex items-center justify-between gap-2">
				<span class="text-sm font-medium text-gray-900">{{ __("Fiscal receipt registered") }}</span>
				<span
					v-if="view.isFake"
					class="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800"
					:title="__('Test receipt, not sent to the tax service')"
					>{{ __("Test receipt") }}</span
				>
			</div>
			<div v-if="view.fiscalNumber" class="mt-1 text-sm text-gray-600">
				{{ __("Fiscal number") }}:
				<span class="font-mono font-semibold text-gray-900">{{ view.fiscalNumber }}</span>
			</div>
		</div>

		<!-- Nothing to fiscalize (the return of a sale that never had a receipt) -->
		<div
			v-else-if="view.level === 'info'"
			class="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700"
		>
			{{ view.message }}
		</div>

		<!-- The receipt was not registered: stays here until the cashier acts -->
		<div
			v-else
			class="rounded-lg border border-red-300 bg-red-50 p-3"
			role="alert"
			data-testid="ua-prro-error"
		>
			<div class="text-sm font-semibold text-red-700">{{ view.title }}</div>
			<p class="mt-1 whitespace-pre-line text-sm text-red-700">{{ view.message }}</p>
			<p v-if="view.details" class="mt-1 text-xs text-red-600">{{ view.details }}</p>
			<div v-if="view.canRetry" class="mt-3">
				<Button
					variant="solid"
					theme="red"
					:loading="retrying"
					:disabled="retrying"
					data-testid="ua-prro-retry"
					@click="emit('retry')"
				>
					{{ __("Fiscalize again") }}
				</Button>
			</div>
		</div>
	</div>
</template>

<script setup>
import { Button } from "frappe-ui";
import { computed } from "vue";
import { formatCurrency } from "@/utils/currency";
import { describeSale } from "@/utils/uaPrro";

/**
 * The fiscal result of a sale in the sale-complete dialog (the block `ua_prro` of the answer of `submit_invoice`,
 * see utils/uaPrro.js): the change to hand over, the fiscal number, or the error with "Fiscalize again".
 */
const props = defineProps({
	block: { type: Object, default: null },
	currency: { type: String, default: "UAH" },
	retrying: { type: Boolean, default: false },
});
const emit = defineEmits(["retry"]);

const view = computed(() => describeSale(props.block));
</script>
