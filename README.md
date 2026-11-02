# Biolyst

Free biotech catalyst tracker: trial dates, FDA decisions and earnings
across ~300 companies, with cash runway next to each date.
Live at https://biolyst.org

## Data
- Trial dates: ClinicalTrials.gov
- Filings and financials: SEC EDGAR
- Economic calendar: FRED / BLS

Rebuilt daily. Runway is estimated from the latest 10-Q at the latest
quarter's burn.

## Not investment advice
Biolyst shows public data. It doesn't recommend buying or selling anything.

## Running locally
Requires Node 18+.

```
setx EDGAR_USER_AGENT "YourName your@email.com"
setx FRED_API_KEY "your-fred-key"
npm run data:full
npm start
```

`setx` is Windows; open a new terminal after running it. The FRED key is
free (https://fredaccount.stlouisfed.org/apikeys) and only needed for the
macro tab.

## License
© 2026 Alex Melemai. All rights reserved.
