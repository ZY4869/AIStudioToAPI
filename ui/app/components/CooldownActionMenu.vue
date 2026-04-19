<template>
    <el-dropdown trigger="click" @command="handleCommand">
        <button
            class="cooldown-action-trigger"
            :class="[buttonClass, `is-${size}`]"
            :disabled="disabled"
            :title="title"
            @click.stop
            @mousedown.stop
        >
            <slot>
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <path d="M12 3v18"></path>
                    <path d="M9 6h6"></path>
                    <path d="M8 12h8"></path>
                    <path d="M7 18h10"></path>
                </svg>
            </slot>
        </button>
        <template #dropdown>
            <el-dropdown-menu>
                <el-dropdown-item command="text">{{ t("clearTextCooldown") }}</el-dropdown-item>
                <el-dropdown-item command="image">{{ t("clearImageCooldown") }}</el-dropdown-item>
                <el-dropdown-item command="all">{{ t("clearAllCooldownAction") }}</el-dropdown-item>
            </el-dropdown-menu>
        </template>
    </el-dropdown>
</template>

<script setup>
import { onMounted, ref } from "vue";
import I18n from "../utils/i18n";

defineProps({
    buttonClass: {
        default: "",
        type: String,
    },
    disabled: {
        default: false,
        type: Boolean,
    },
    size: {
        default: "small",
        type: String,
    },
    title: {
        default: "",
        type: String,
    },
});

const emit = defineEmits(["select"]);

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

const handleCommand = command => {
    emit("select", command);
};
</script>

<style scoped lang="less">
.cooldown-action-trigger {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #dcdfe6;
    background: #ffffff;
    color: #606266;
    cursor: pointer;
    transition: all 0.2s;

    &:hover:not(:disabled) {
        border-color: #409eff;
        color: #409eff;
    }

    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    &.btn-warning:hover:not(:disabled) {
        border-color: #e6a23c;
        color: #e6a23c;
    }

    &.is-normal {
        width: 36px;
        height: 36px;
        border-radius: 8px;
    }

    &.is-small {
        width: 28px;
        height: 28px;
        border-radius: 6px;
    }
}
</style>
