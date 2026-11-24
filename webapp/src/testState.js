// Module-level state (stores, registries) outlives the test that changed it, and a test that forgets to reset it
// breaks the tests after it, in some orders only. In the tests, what's registered here is reset after each test
// (src/setupTests.js), as are the zustand stores, but the persisted preferences (src/stores/prefs.js), which tests set
// themselves. Outside of the tests it does nothing.
//   const providers = [...];
//   resetAfterEachTest(() => providers.splice(0, Infinity, ...defaults));
const resets = new Set();

export const resetAfterEachTest = reset => {
  if (import.meta.env.MODE === 'test') resets.add(reset);
};

export const resetTestState = () => resets.forEach(reset => reset());
