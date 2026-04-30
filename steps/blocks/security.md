This task involves authentication, authorization, or security.
1. Ensure all endpoints use the @require_roles decorator with appropriate roles.
2. Verify CORS headers are present on ALL responses including error responses.
3. Never expose internal error details to the client — log internally, return generic message.
4. Check that user input is validated before use in database queries or business logic.
