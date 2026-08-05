pub mod organization;

pub fn register_automation_handlers() {
    crate::automation::consumer::register(std::sync::Arc::new(
        organization::MemoryOrganizationHandler,
    ));
}
