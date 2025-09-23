import fetch from 'node-fetch';
import fs from 'fs'
import dayjs from 'dayjs';

var StartDate = process.argv[2]; // uses YYYY-MM-DD format
var ARCAccountCode = process.argv[3];
var ARCSubscriptionCode = process.argv[4];

if(!StartDate || !ARCAccountCode || !ARCSubscriptionCode){
	console.log("Usage: node index.js <Start date, YYYY-MM-DD> <ARC Account Code> <ARC Subscription Code>");
	process.exit(1);
}	

main();

async function main(){

	var totalTimeStart = Date.now();
	var timeStart = totalTimeStart;
	var domains = await GetDomainList();
	var timeEnd = Date.now();
	console.log(`GetDomainList took ${Math.floor((timeEnd-timeStart) / 1000)} seconds`);

	timeStart = Date.now();
	await domains.reduce(async(previous, domain) =>{
		await previous;
		await GetDomainHistory(domain);
	}, undefined);
	var timeEnd = Date.now();
	console.log(`GetDomainHistory took ${Math.floor((timeEnd-timeStart) / 1000)} seconds for ${domains.length} domains`);

	timeStart = Date.now();
	WriteCSV(domains);
	var totalTimeEnd = Date.now();
	timeEnd = totalTimeEnd;
	console.log(`Writing data to file took ${Math.floor((timeEnd-timeStart) / 1000)} seconds`);

	var templateFilename = `${dayjs(StartDate).format("MMM YYYY")} Delta Report.xlsx`;
	fs.copyFileSync('report template.xlsx', templateFilename);
	console.log(`Template file created: ${templateFilename}`);

	console.log(`Total elapsed time: ${Math.floor((totalTimeEnd-totalTimeStart) / 1000)} seconds`);
}

async function GetDomainHistory(domain){
	var requestURL = `https://api.tpgarc.com/v2/Dashboard/GetDomainDashboardHistory?domainID=${domain.id}&engineKey=AXE&startDate=${StartDate}`
	var data;

	console.log(`Getting history for ${domain.url}`);
	try{
		var response = await fetch(requestURL, {
			method: 'GET',
			headers: {
				'accept': 'application/json', 
				'arc-account-code': ARCAccountCode,
	            'arc-subscription-key': ARCSubscriptionCode
			}
		});
		data = await response.json();
		
		if(data.length > 1){
			data.sort(SortScanHistoryDescending);

			domain.scanHistory.push(data[0]);
			domain.scanHistory.push(data.at(-1));		
		} else if(data.length == 1) {
			domain.scanHistory.push(data[0]);
			domain.scanHistory.push(data[0]);
		} else {
			console.log("--- NO SCAN DATA!");
		}
	}
	catch(ex){
		console.log(`Error obtaining domain history for ${domain.id}-${domain.url} : ${ex}`);
		console.dir("DATA: ", data);
	}

	return domain;
}

function SortScanHistoryDescending(scanEntryL, scanEntryR){
	return scanEntryR.scanLogID - scanEntryL.scanLogID;
}

async function GetDomainList(){
	var domains = [];

	var response = await fetch('https://api.tpgarc.com/v2/Domains/GetDomains', {
		method: 'GET',
		headers: {
			'accept': 'application/json', 
			'arc-account-code': ARCAccountCode,
            'arc-subscription-key': ARCSubscriptionCode
		}
	});

	try{
		var data = await response.json();
		data.forEach((entry) =>{
			if(entry.active){
				var domain = {};
				domain.id = entry.id;
				domain.url = entry.url;
				data.title = entry.title;
				domain.scanHistory = [];
				domains.push(domain);
			}
		});
	}
	catch(ex){
		console.log(`Error obtaining list of account domains: ${ex}`);
	}


	return domains;
}

function FindDelta(left, right){
	var deltas = {};

	deltas.delta = left - right;

	if(right > 0){
		deltas.percentage = Math.round((((left/right) + Number.EPSILON) * 100) - 100) / 100;
	} else {
		deltas.percentage = 1;
	}

	return deltas;
}

function ParseDate(dateTimeString){
	var index = dateTimeString.indexOf('T');

	return dateTimeString.substring(0,index);
}

function WriteCSV(domains){
	var headers = 	'Domain ID,Domain,Scan Date,' +
					'Pages Found,Pages Found Delta,Paged Found Delta as %,' +
					'Pages Scanned,Pages Scanned Delta,Pages Scanned Delta as %,' +
					'Errors/Assertions,Errors/Assertions Delta,Errors/Assertions Delta as %,' +
					'WCAG Density,WCAG Density Delta,WCAG Density Delta as %,' +
					'WCAG Failures,WCAG Failures Delta,WCAG Failures Delta as %,' +
					'ScanLog ID';

	fs.writeFileSync('Full Data.csv', headers+'\n');
	fs.writeFileSync('Deltas.csv', headers+'\n');
	
	domains.forEach((domain)=>{
		if(domain.scanHistory.length){
			var currentScan = domain.scanHistory[0]; //s1
			var previousScan = domain.scanHistory[1]; //s2

			var pagesFoundDeltas;
			var pagesScannedDeltas;
			var assertionCountDeltas;
			var wcagDensityDeltas;
			var checkpointFailuresDeltas;

			pagesFoundDeltas = FindDelta(currentScan.componentsScanned, previousScan.componentsScanned);
			pagesScannedDeltas = FindDelta(currentScan.componentsAnalyzed, previousScan.componentsAnalyzed);
			assertionCountDeltas = FindDelta(currentScan.assertionCount, previousScan.assertionCount);
			wcagDensityDeltas = FindDelta(currentScan.wcagDensity, previousScan.wcagDensity);
			checkpointFailuresDeltas = FindDelta(currentScan.checkpointFailures, previousScan.checkpointFailures);
	
			var dataRow1 = `${domain.id},${domain.url},${ParseDate(currentScan.scanDate)},` +
			`${currentScan.componentsScanned},${pagesFoundDeltas.delta},${pagesFoundDeltas.percentage},` +
			`${currentScan.componentsAnalyzed},${pagesScannedDeltas.delta},${pagesScannedDeltas.percentage},` +
			`${currentScan.assertionCount},${assertionCountDeltas.delta},${assertionCountDeltas.percentage},` +
			`${currentScan.wcagDensity},${wcagDensityDeltas.delta},${wcagDensityDeltas.percentage},` +
			`${currentScan.checkpointFailures},${checkpointFailuresDeltas.delta},${checkpointFailuresDeltas.percentage},` +
			`${currentScan.scanLogID}\n`;
			
			fs.appendFileSync('Full Data.csv',dataRow1);
			fs.appendFileSync('Deltas.csv',dataRow1);

			var dataRow2 = `${domain.id},${domain.url},${ParseDate(previousScan.scanDate)},` +
							`${previousScan.componentsScanned},"","",` +
							`${previousScan.componentsAnalyzed},"","",` +
							`${previousScan.assertionCount},"","",` +
							`${previousScan.wcagDensity},"","",` +
							`${previousScan.checkpointFailures},"","",` +
							`${previousScan.scanLogID}\n`;
			fs.appendFileSync('Full Data.csv',dataRow2);
		}
	});
}