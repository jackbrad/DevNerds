This task spans multiple services or layers.
1. Identify the interfaces between the services involved.
2. Make changes that maintain interface contracts — don't break other services.
3. Test the integration between services, not just each side independently.
4. If you need to change a shared utility (lambda_functions/shared/), verify it doesn't break other consumers.
