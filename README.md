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
npm install
setx EDGAR_USER_AGENT "Name your@email.com"
npm run data:full
npm start

## License
...