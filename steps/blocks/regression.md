This is a regression — something that previously worked is now broken.
1. Identify which recent change likely caused the regression (check git log for the affected area).
2. Fix the regression without reverting the change that caused it (unless no other fix is possible).
3. Add a regression test that specifically covers this scenario.
4. Verify that the original change's intended behavior still works after your fix.
