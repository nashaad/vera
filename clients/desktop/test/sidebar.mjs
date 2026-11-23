// Picks Group by from the sessions list's filter menu, the way a person does. The button's
// label reflects the stored choice even while the home has no sessions to draw.
export async function setSidebarGrouping(page, choice) {
    const label = choice === "folder" ? "Folder" : "None";
    await page.locator(".sessions-filter").click();
    await page.getByRole("menuitemcheckbox", { name: label, exact: true }).click();
    await page.locator(`.sessions-filter[aria-label="Filter sessions, grouped by ${label}"]`).waitFor({ timeout: 10_000 });
}
