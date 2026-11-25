import { theme, type ThemeConfig } from 'antd'

export const iceColors = {
  app: '#EDF3F6',
  surface: '#FFFFFF',
  surfaceSubtle: '#EBF4F6',
  chrome: '#F6F9FA',
  canvas: '#F5FAFB',
  text: '#183044',
  textSecondary: '#486377',
  textTertiary: '#546F82',
  borderSubtle: '#D7E4E9',
  borderControl: '#819BAA',
  brand: '#126B80',
  brandHover: '#0D5B70',
  brandActive: '#0C4A5B',
  brandSoft: '#E1F1F3',
  brandDecorative: '#3291A5',
  gridDot: '#D2E2E8',
  edge: '#7793A5',
  nodeBorder: '#A6C0CC',
  success: '#147D57',
  successBg: '#EAF8F1',
  danger: '#C6324D',
  dangerBg: '#FFF0F3',
  warning: '#9B5A08',
  warningBg: '#FFF6E7',
  iconExtract: '#6753BC',
  iconControl: '#9B5A08',
} as const

export const iceFonts = {
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif",
  mono: "ui-monospace, 'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
} as const

export const iceShadows = {
  panel: '0 12px 30px rgba(25,61,77,.055)',
  node: '0 3px 8px rgba(24,58,75,.075)',
  selected: '0 0 0 3px rgba(18,107,128,.14), 0 5px 16px rgba(24,58,75,.09)',
  overlay: '0 18px 48px rgba(25,61,77,.16)',
} as const

export const iceChartTheme = {
  color: [iceColors.success, iceColors.danger, iceColors.brand, iceColors.warning],
  backgroundColor: 'transparent',
  textStyle: { color: iceColors.textSecondary, fontFamily: iceFonts.sans, fontSize: 12 },
  categoryAxis: {
    axisLine: { lineStyle: { color: iceColors.borderSubtle } },
    axisLabel: { color: iceColors.textSecondary },
    axisTick: { show: false },
  },
  valueAxis: {
    axisLabel: { color: iceColors.textSecondary },
    splitLine: { lineStyle: { color: iceColors.borderSubtle } },
  },
  legend: { textStyle: { color: iceColors.textSecondary } },
  tooltip: {
    backgroundColor: iceColors.surface,
    borderColor: iceColors.borderSubtle,
    textStyle: { color: iceColors.text },
    extraCssText: `box-shadow:${iceShadows.panel};border-radius:9px;`,
  },
} as const

export function applyIceAppearance(root: HTMLElement): void {
  root.dataset.flowtestTheme = 'ice-light'
  root.style.colorScheme = 'light'
  for (const [name, value] of Object.entries(iceColors)) {
    root.style.setProperty(
      `--ft-${name.replace(/[A-Z]/g, (part) => `-${part.toLowerCase()}`)}`,
      value,
    )
  }
  for (const [name, value] of Object.entries(iceShadows))
    root.style.setProperty(`--ft-shadow-${name}`, value)
  root.style.setProperty('--ft-font-sans', iceFonts.sans)
  root.style.setProperty('--ft-font-mono', iceFonts.mono)
}

export function createIceTheme(reduceMotion: boolean): ThemeConfig {
  return {
    algorithm: theme.defaultAlgorithm,
    token: {
      colorPrimary: iceColors.brand,
      colorPrimaryHover: iceColors.brandHover,
      colorPrimaryActive: iceColors.brandActive,
      colorPrimaryBg: iceColors.brandSoft,
      colorLink: iceColors.brand,
      colorBgLayout: iceColors.app,
      colorBgContainer: iceColors.surface,
      colorBgElevated: iceColors.surface,
      colorBgMask: 'rgba(36,64,80,.30)',
      colorBgSolid: iceColors.brand,
      colorBgSolidHover: iceColors.brandHover,
      colorBgSolidActive: iceColors.brandActive,
      colorText: iceColors.text,
      colorTextHeading: iceColors.text,
      colorTextSecondary: iceColors.textSecondary,
      colorTextTertiary: iceColors.textTertiary,
      colorTextDescription: iceColors.textSecondary,
      colorTextPlaceholder: iceColors.textTertiary,
      colorBorder: iceColors.borderControl,
      colorBorderSecondary: iceColors.borderSubtle,
      colorSplit: iceColors.borderSubtle,
      colorSuccess: iceColors.success,
      colorSuccessBg: iceColors.successBg,
      colorError: iceColors.danger,
      colorErrorBg: iceColors.dangerBg,
      colorWarning: iceColors.warning,
      colorWarningBg: iceColors.warningBg,
      colorInfo: iceColors.brand,
      fontFamily: iceFonts.sans,
      fontFamilyCode: iceFonts.mono,
      fontSize: 14,
      fontSizeSM: 12,
      controlHeight: 36,
      controlHeightLG: 40,
      borderRadius: 9,
      borderRadiusLG: 14,
      borderRadiusSM: 6,
      motion: !reduceMotion,
      boxShadow: iceShadows.overlay,
      boxShadowSecondary: iceShadows.panel,
    },
    components: {
      Tooltip: { colorBgSpotlight: iceColors.surface, colorTextLightSolid: iceColors.text },
      Menu: {
        itemBg: iceColors.chrome,
        itemSelectedBg: iceColors.brandSoft,
        itemSelectedColor: iceColors.brand,
      },
      Table: {
        headerBg: iceColors.chrome,
        headerColor: iceColors.textSecondary,
        rowHoverBg: iceColors.canvas,
      },
      Card: { headerFontSize: 16 },
      Tabs: { titleFontSize: 14 },
    },
  }
}
