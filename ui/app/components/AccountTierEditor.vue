<template>
    <div class="account-tier-editor" @click.stop @mousedown.stop>
        <span class="tier-badge" :class="`is-${effectiveTier}`">
            {{ tierLabel }}
        </span>
        <el-select
            :model-value="effectiveTier"
            :disabled="disabled"
            class="tier-select"
            size="small"
            @change="handleChange"
        >
            <el-option v-for="option in tierOptions" :key="option" :label="t(tierLabelKeys[option])" :value="option" />
        </el-select>
    </div>
</template>

<script setup>
import { computed, onMounted, ref } from "vue";
import I18n from "../utils/i18n";

const props = defineProps({
    disabled: {
        default: false,
        type: Boolean,
    },
    modelValue: {
        default: "default",
        type: String,
    },
});

const emit = defineEmits(["update"]);

const langVersion = ref(0);
const handleLangChange = lang => {
    void lang;
    langVersion.value += 1;
};

onMounted(() => {
    I18n.onChange(handleLangChange);
});

const t = key => {
    langVersion.value;
    return I18n.t(key);
};

const tierOptions = ["default", "pro", "ultra"];
const tierLabelKeys = {
    default: "accountTierDefault",
    pro: "accountTierPro",
    ultra: "accountTierUltra",
};

const effectiveTier = computed(() => (tierOptions.includes(props.modelValue) ? props.modelValue : "default"));
const tierLabel = computed(() => t(tierLabelKeys[effectiveTier.value]));

const handleChange = value => {
    if (!tierOptions.includes(value)) {
        return;
    }

    emit("update", value);
};
</script>

<style scoped lang="less">
.account-tier-editor {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
}

.tier-badge {
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1;
    padding: 4px 8px;
    white-space: nowrap;

    &.is-default {
        background: rgba(148, 163, 184, 0.18);
        color: #475569;
    }

    &.is-pro {
        background: rgba(59, 130, 246, 0.16);
        color: #1d4ed8;
    }

    &.is-ultra {
        background: rgba(245, 158, 11, 0.18);
        color: #b45309;
    }
}

.tier-select {
    width: 112px;
}
</style>
