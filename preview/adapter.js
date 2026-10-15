/* Only the isolated preview builder loads this entry point. It never intercepts fetch. */
window.PreviewProduct = window.createMockProduct(window.PREVIEW_GUIDES, {
  extendedGallery:true,
  getScenario: () => document.getElementById('preview-scenario')?.value || 'normal',
  getDelay: () => Number(document.getElementById('preview-delay')?.value || 450)
});
