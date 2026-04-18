/**
 * File: src/utils/PacificTimeUtils.js
 * Description: Utilities for working with America/Los_Angeles day boundaries
 */

const PACIFIC_TIME_ZONE = "America/Los_Angeles";

const PACIFIC_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
});

function getPacificDayBucket(date = new Date()) {
    const parts = PACIFIC_DAY_FORMATTER.formatToParts(date);
    const lookup = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function getNextPacificMidnight(date = new Date()) {
    const currentBucket = getPacificDayBucket(date);
    let lowerBound = new Date(date.getTime());
    let upperBound = new Date(date.getTime());

    while (getPacificDayBucket(upperBound) === currentBucket) {
        upperBound = new Date(upperBound.getTime() + 60 * 60 * 1000);
    }

    while (upperBound.getTime() - lowerBound.getTime() > 1000) {
        const midpoint = new Date(Math.floor((lowerBound.getTime() + upperBound.getTime()) / 2));
        if (getPacificDayBucket(midpoint) === currentBucket) {
            lowerBound = midpoint;
        } else {
            upperBound = midpoint;
        }
    }

    return new Date(Math.ceil(upperBound.getTime() / 1000) * 1000);
}

function getNextPacificMidnightIso(date = new Date()) {
    return getNextPacificMidnight(date).toISOString();
}

module.exports = {
    getNextPacificMidnight,
    getNextPacificMidnightIso,
    getPacificDayBucket,
    PACIFIC_TIME_ZONE,
};
